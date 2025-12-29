import dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Настройки продуктов
const PRODUCTS = ["BTC-USD", "ETH-USD"];

// Coinbase Settings (для Истории, Тикера и Сделок)
const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

// Binance Settings (ТОЛЬКО для Стакана/OrderBook)
const BINANCE_WS_BASE = "wss://stream.binance.us:9443/stream?streams="; // Используем stream для мульти-пар

const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;
const CHUNK_LIMIT = 300;

// =======================
// ХРАНИЛИЩА
// =======================
const historyStore = {};
const orderbookStore = {}; // Теперь здесь храним готовые массивы от Binance
const tradesStore = {};
const latestPrice = {};

// =======================
// UTILS
// =======================

// Карта соответствия имен: Coinbase <-> Binance
// Coinbase: "BTC-USD", Binance: "btcusdt"
function getBinanceSymbol(product) {
  return product.replace("-", "").toLowerCase() + "t"; // костыль для usdt: BTC-USD -> btcusdt
}

function getCoinbaseSymbol(binanceStreamName) {
  // binanceStreamName пример: "btcusdt@depth20@100ms"
  const symbol = binanceStreamName.split("@")[0];
  const raw = symbol.toUpperCase().replace("USDT", "-USD"); // btcusdt -> BTC-USD
  // Если у вас будут пары не только к USD, тут нужна логика сложнее, но для BTC/ETH подойдет
  return raw; 
}

function mapCandlesFromCoinbase(arr) {
  if (!Array.isArray(arr)) return [];
  const map = new Map();
  for (const c of arr) {
    const t = Math.floor(c[0]);
    map.set(t, {
      time: t,
      open: Number(c[3]),
      high: Number(c[2]),
      low: Number(c[1]),
      close: Number(c[4]),
    });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// Форматирование данных от Binance в формат вашего приложения
function formatBinanceOrderBook(bids, asks) {
  // Binance шлет строки ["20000.00", "0.5"], нам нужны числа { price, size }
  const format = (arr) => arr.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  return {
    buy: format(bids),
    sell: format(asks)
  };
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  const pair = msg.pair;
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (pair && ws.subscriptions && !ws.subscriptions.has(pair)) return;
    ws.send(text);
  });
}

// =======================
// HISTORY (COINBASE REST)
// =======================
async function loadHistoryFor(product) {
  const now = Math.floor(Date.now() / 1000);
  let raw = [];
  let fetched = 0;
  console.log(`Loading history for ${product}...`);
  
  while (fetched < HISTORY_CANDLES) {
    const to = now - fetched * GRANULARITY;
    const from = to - CHUNK_LIMIT * GRANULARITY;
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}&start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
      if (!r.ok) break;
      const chunk = await r.json();
      if (!chunk || chunk.length === 0) break;
      raw.push(...chunk);
      fetched += CHUNK_LIMIT;
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error(`Error fetching history for ${product}:`, e.message);
      break;
    }
  }
  historyStore[product] = mapCandlesFromCoinbase(raw).slice(-HISTORY_CANDLES);
  console.log(`✅ History loaded for ${product}: ${historyStore[product].length} candles`);
}

// =======================
// BINANCE WS (ORDER BOOK)
// =======================
let binanceWS;

function connectBinanceWS() {
  // Формируем URL для подписки сразу на все пары
  // Пример: stream?streams=btcusdt@depth20@100ms/ethusdt@depth20@100ms
  const streams = PRODUCTS.map(p => `${getBinanceSymbol(p)}@depth20@100ms`).join("/");
  const url = `${BINANCE_WS_BASE}${streams}`;

  console.log(`Connecting to Binance WS for OrderBook... (${url})`);
  binanceWS = new WebSocket(url);

  binanceWS.on("open", () => {
    console.log("✅ Binance WS connected (Order Books)");
  });

  binanceWS.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      // Формат Combined Stream: { stream: "btcusdt@depth20@100ms", data: { lastUpdateId, bids, asks } }
      if (msg.data && msg.stream) {
        const pair = getCoinbaseSymbol(msg.stream);
        
        // Преобразуем сразу в нужный формат и сохраняем
        orderbookStore[pair] = formatBinanceOrderBook(msg.data.bids, msg.data.asks);
        
        // Тут мы НЕ делаем broadcast сразу, так как у вас есть отдельный интервал для этого (внизу),
        // чтобы не спамить клиентов каждые 100мс, если не нужно.
      }
    } catch (e) {
      console.error("Error parsing Binance message:", e);
    }
  });

  binanceWS.on("close", () => {
    console.log("Binance WS closed — reconnecting in 2s...");
    setTimeout(connectBinanceWS, 2000);
  });

  binanceWS.on("error", err => {
    console.error("Binance WS error:", err.message);
  });
}

// =======================
// COINBASE WS (TICKER + TRADES)
// =======================
let coinbaseWS;

function connectCoinbaseWS() {
  console.log("Connecting to Coinbase WS for Ticker/Trades...");
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open", () => {
    console.log("✅ Coinbase WS connected — subscribing...");
    coinbaseWS.send(JSON.stringify({
      type: "subscribe",
      product_ids: PRODUCTS,
      channels: ["ticker", "matches"] // УБРАЛИ "level2", так как стакан теперь от Binance
    }));
  });

  coinbaseWS.on("message", raw => {
    try {
      const m = JSON.parse(raw.toString());
      handleCoinbaseMessage(m);
    } catch (e) {
      console.error("Error parsing Coinbase message:", e);
    }
  });

  coinbaseWS.on("close", () => {
    console.log("Coinbase WS closed — reconnecting in 5s...");
    setTimeout(connectCoinbaseWS, 5000);
  });
}

function handleCoinbaseMessage(m) {
  const pair = m.product_id;
  if (!PRODUCTS.includes(pair)) return;

  // TICKER
  if (m.type === "ticker") {
    latestPrice[pair] = Number(m.price);
    broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
    return;
  }

  // TRADES
  if (m.type === "match") {
    if (!tradesStore[pair]) tradesStore[pair] = [];
    tradesStore[pair].push({
      price: Number(m.price),
      size: Number(m.size),
      side: m.side,
      time: new Date(m.time).getTime()
    });
    if (tradesStore[pair].length > 100) tradesStore[pair].shift();
    
    // Broadcast trades immediately
    broadcast({ type: "trades", pair, trades: tradesStore[pair].slice(-20) });
    return;
  }
}

// =======================
// ORDERBOOK BROADCAST LOOP
// =======================
// Отправляем клиентам данные стакана (которые теперь обновляются от Binance)
setInterval(() => {
  PRODUCTS.forEach(pair => {
    const ob = orderbookStore[pair];
    if (!ob) return; // Данных от Binance еще нет

    // ob уже содержит { buy: [], sell: [] } в нужном формате
    broadcast({ 
      type: "orderBook", 
      pair, 
      buy: ob.buy, 
      sell: ob.sell, 
      ts: Date.now() 
    });
    
    // Log для отладки (можно закомментировать, чтобы не спамило в консоль)
    // console.log(`📤 Sent OB for ${pair} (Bids: ${ob.buy.length}, Asks: ${ob.sell.length})`);
  });
}, 200); // 200ms троттлинг для клиентов

// =======================
// CLIENT WS SERVER
// =======================
wss.on("connection", ws => {
  ws.subscriptions = new Set();

  ws.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());

      // Subscribe
      if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
        ws.subscriptions.add(data.pair);
        console.log(`Client subscribed to ${data.pair}`);

        // Send Initial Data
        if (historyStore[data.pair]) {
          ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        }
        if (latestPrice[data.pair]) {
          ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        }
        if (orderbookStore[data.pair]) {
          const ob = orderbookStore[data.pair];
          ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, buy: ob.buy, sell: ob.sell }));
        }
        return;
      }

      // Unsubscribe
      if (data.type === "unsubscribe" && data.pair) {
        if (ws.subscriptions.has(data.pair)) {
          ws.subscriptions.delete(data.pair);
          console.log(`Client unsubscribed from ${data.pair}`);
        }
        return;
      }
    } catch (e) {
      console.error("Error handling client message:", e);
    }
  });

  ws.on("close", () => {
    // console.log("Client disconnected");
  });
});

// =======================
// INIT
// =======================
async function init() {
  console.log("Initializing Hybrid Server (Base: Coinbase, OB: Binance)...");
  
  // 1. Грузим историю (Coinbase REST)
  for (const p of PRODUCTS) {
    await loadHistoryFor(p);
  }

  // 2. Подключаем сокеты
  connectCoinbaseWS(); // Для цены и сделок
  connectBinanceWS();  // Для стакана

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

init();

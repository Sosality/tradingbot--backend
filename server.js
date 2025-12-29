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

// Coinbase Settings (ТОЛЬКО для загрузки истории свечей REST)
const COINBASE_REST = "https://api.exchange.coinbase.com";

// Binance Settings (Стакан + Цена + Сделки)
const BINANCE_WS_BASE = "wss://stream.binance.us:9443/stream?streams=";

const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;
const CHUNK_LIMIT = 300;

// =======================
// ХРАНИЛИЩА
// =======================
const historyStore = {};
const orderbookStore = {}; 
const tradesStore = {};
const latestPrice = {};

// =======================
// UTILS
// =======================

// Карта соответствия имен: Coinbase <-> Binance
function getBinanceSymbol(product) {
  return product.replace("-", "").toLowerCase() + "t"; // BTC-USD -> btcusdt
}

function getCoinbaseSymbol(binanceStreamName) {
  // binanceStreamName может быть "btcusdt@depth20", "btcusdt@trade" и т.д.
  const symbol = binanceStreamName.split("@")[0];
  const raw = symbol.toUpperCase().replace("USDT", "-USD"); // btcusdt -> BTC-USD
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

// Форматирование стакана от Binance
function formatBinanceOrderBook(bids, asks) {
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
// Мы оставили Coinbase только для этого — загрузить график при старте
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
// BINANCE WS (EVERYTHING REALTIME)
// =======================
let binanceWS;

function connectBinanceWS() {
  // Подписываемся на:
  // 1. depth20@100ms (Стакан)
  // 2. trade (Сделки в реальном времени)
  // 3. ticker (Текущая цена 24ч)
  const streams = PRODUCTS.map(p => {
    const sym = getBinanceSymbol(p);
    return `${sym}@depth20@100ms/${sym}@trade/${sym}@ticker`;
  }).join("/");
  
  const url = `${BINANCE_WS_BASE}${streams}`;

  console.log(`Connecting to Binance WS...`);
  binanceWS = new WebSocket(url);

  binanceWS.on("open", () => {
    console.log("✅ Binance WS connected (OrderBook, Price, Trades)");
  });

  binanceWS.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.data || !msg.stream) return;

      const pair = getCoinbaseSymbol(msg.stream); // Получаем BTC-USD
      const streamType = msg.stream.split("@")[1]; // depth20, trade, ticker

      // --- 1. ОБРАБОТКА СТАКАНА (OrderBook) ---
      if (streamType.startsWith("depth")) {
        orderbookStore[pair] = formatBinanceOrderBook(msg.data.bids, msg.data.asks);
        // Не отправляем broadcast здесь, это делает setInterval ниже
      }

      // --- 2. ОБРАБОТКА ЦЕНЫ (Ticker) ---
      else if (streamType === "ticker") {
        const newPrice = Number(msg.data.c); // 'c' - current close price
        latestPrice[pair] = newPrice;
        
        // Отправляем клиенту обновление цены сразу
        broadcast({ type: "price", pair, price: newPrice, ts: Date.now() });
      }

      // --- 3. ОБРАБОТКА СДЕЛОК (Trades) ---
      else if (streamType === "trade") {
        if (!tradesStore[pair]) tradesStore[pair] = [];
        
        // Binance trade format: { p: price, q: quantity, T: timestamp, m: isBuyerMaker }
        // Если isBuyerMaker = true, значит мейкер (тот кто поставил лимитку) был покупателем -> значит это продажа (Sell) по рынку
        const side = msg.data.m ? "sell" : "buy"; 
        
        tradesStore[pair].push({
          price: Number(msg.data.p),
          size: Number(msg.data.q),
          side: side,
          time: msg.data.T
        });

        if (tradesStore[pair].length > 100) tradesStore[pair].shift();
        
        // Отправляем клиенту последние сделки
        broadcast({ type: "trades", pair, trades: tradesStore[pair].slice(-20) });
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
// ORDERBOOK BROADCAST LOOP
// =======================
// Отправляем стакан каждые 200мс, чтобы не спамить
setInterval(() => {
  PRODUCTS.forEach(pair => {
    const ob = orderbookStore[pair];
    if (!ob) return; 

    broadcast({ 
      type: "orderBook", 
      pair, 
      buy: ob.buy, 
      sell: ob.sell, 
      ts: Date.now() 
    });
  });
}, 200);

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

        // 1. History (Coinbase)
        if (historyStore[data.pair]) {
          ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        }
        // 2. Latest Price (Binance)
        if (latestPrice[data.pair]) {
          ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        }
        // 3. Order Book (Binance)
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
        }
        return;
      }
    } catch (e) {
      console.error("Error handling client message:", e);
    }
  });
});

// =======================
// INIT
// =======================
async function init() {
  console.log("Initializing Unified Server (Base: Coinbase History, Realtime: Binance)...");
  
  // 1. Грузим историю свечей (Coinbase REST) - нужно только 1 раз при старте
  for (const p of PRODUCTS) {
    await loadHistoryFor(p);
  }

  // 2. Подключаем Binance для ВСЕГО остального (Цена, Стакан, Сделки)
  connectBinanceWS();

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

init();

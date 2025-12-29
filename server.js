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

// === НАСТРОЙКИ ===
const PRODUCTS = ["BTC-USD", "ETH-USD"];

// Coinbase (Только для загрузки графика/истории при старте)
const COINBASE_REST = "https://api.exchange.coinbase.com";

// Binance (Для всего Realtime: Цена, Стакан, Сделки)
// Используем binance.us как в твоем исходнике. 
// Если данных мало, можно поменять на stream.binance.com:9443
const BINANCE_WS_BASE = "wss://stream.binance.us:9443/stream?streams=";

const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;
const CHUNK_LIMIT = 300;

// === ХРАНИЛИЩА ===
const historyStore = {};
const orderbookStore = {};
const tradesStore = {}; // Здесь храним последние 50 сделок
const latestPrice = {};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// BTC-USD -> btcusdt
function getBinanceSymbol(product) {
  return product.replace("-", "").toLowerCase() + "t"; 
}

// btcusdt -> BTC-USD
function getCoinbaseSymbol(binanceStreamName) {
  // binanceStreamName пример: "btcusdt@aggTrade" или "btcusdt@depth20"
  const symbol = binanceStreamName.split("@")[0];
  return symbol.toUpperCase().replace("USDT", "-USD");
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

// Форматирование стакана из строк Binance в числа
function formatBinanceOrderBook(bids, asks) {
  const format = (arr) => arr.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  return {
    buy: format(bids),
    sell: format(asks)
  };
}

// Функция рассылки всем подписчикам пары
function broadcast(msg) {
  const text = JSON.stringify(msg);
  const pair = msg.pair;
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Отправляем только тем, кто подписан на эту пару
    if (pair && ws.subscriptions && !ws.subscriptions.has(pair)) return;
    ws.send(text);
  });
}

// === 1. ЗАГРУЗКА ИСТОРИИ (COINBASE REST) ===
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

// === 2. BINANCE WEBSOCKET (REALTIME DATA) ===
let binanceWS;

function connectBinanceWS() {
  // Подписываемся на 3 канала для каждой пары:
  // 1. depth20@100ms - Стакан
  // 2. aggTrade - Сделки (агрегированные, так надежнее)
  // 3. ticker - Цена 24ч
  const streams = PRODUCTS.map(p => {
    const sym = getBinanceSymbol(p);
    return `${sym}@depth20@100ms/${sym}@aggTrade/${sym}@ticker`;
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
      const streamName = msg.stream.split("@")[1]; // depth20, aggTrade, ticker

      // --- A. СТАКАН (OrderBook) ---
      if (streamName.startsWith("depth")) {
        orderbookStore[pair] = formatBinanceOrderBook(msg.data.bids, msg.data.asks);
        // Не отправляем broadcast здесь, чтобы не спамить. Это делает setInterval ниже.
      }

      // --- B. ЦЕНА (Ticker) ---
      else if (streamName === "ticker") {
        const newPrice = Number(msg.data.c); // c = current price
        latestPrice[pair] = newPrice;
        broadcast({ type: "price", pair, price: newPrice, ts: Date.now() });
      }

      // --- C. СДЕЛКИ (Trades) ---
      // aggTrade формат: { p: price, q: quantity, T: timestamp, m: isMaker }
      else if (streamName === "aggTrade") {
        if (!tradesStore[pair]) tradesStore[pair] = [];
        
        // Если isMaker (m) = true, значит инициатор выставил лимитку (продавец), а второй купил.
        // Но в визуализации обычно: красный (sell) если цена падает или бьют в биды.
        // Binance logic: m=true -> Sell order filled (Maker was buyer? No. Maker is passive).
        // Проще: m=true -> SELL (red), m=false -> BUY (green)
        const side = msg.data.m ? "sell" : "buy"; 
        
        const trade = {
          price: Number(msg.data.p),
          size: Number(msg.data.q),
          side: side,
          time: msg.data.T
        };

        tradesStore[pair].push(trade);
        
        // Храним только последние 50 сделок в памяти
        if (tradesStore[pair].length > 50) tradesStore[pair].shift();
        
        // Отправляем сделку клиентам сразу
        // Клиент ждет массив 'trades'
        broadcast({ type: "trades", pair, trades: [trade] });
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

// === РАССЫЛКА СТАКАНА (Throttling 200ms) ===
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

// === 3. CLIENT WEBSOCKET SERVER ===
wss.on("connection", ws => {
  ws.subscriptions = new Set();

  ws.on("message", async raw => {
    try {
      const data = JSON.parse(raw.toString());

      // ПОДПИСКА
      if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
        ws.subscriptions.add(data.pair);
        console.log(`Client subscribed to ${data.pair}`);

        // 1. Отправляем ИСТОРИЮ графика
        if (historyStore[data.pair]) {
          ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        }

        // 2. Отправляем текущую ЦЕНУ
        if (latestPrice[data.pair]) {
          ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        }

        // 3. Отправляем СТАКАН
        if (orderbookStore[data.pair]) {
          const ob = orderbookStore[data.pair];
          ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, buy: ob.buy, sell: ob.sell }));
        }

        // 4. [FIX] Отправляем ПОСЛЕДНИЕ СДЕЛКИ (чтобы список не был пустым при старте)
        if (tradesStore[data.pair] && tradesStore[data.pair].length > 0) {
           // Отправляем последние 20 сделок списком
           ws.send(JSON.stringify({ 
             type: "trades", 
             pair: data.pair, 
             trades: tradesStore[data.pair].slice(-20) 
           }));
        }

        return;
      }

      // ОТПИСКА
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

// === ЗАПУСК ===
async function init() {
  console.log("Initializing Unified Server...");
  
  // 1. Грузим историю свечей (REST)
  for (const p of PRODUCTS) {
    await loadHistoryFor(p);
  }

  // 2. Подключаем Binance WS
  connectBinanceWS();

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

init();

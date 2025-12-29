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

const PRODUCTS = ["BTC-USD", "ETH-USD"];

// Coinbase только для истории
const COINBASE_REST = "https://api.exchange.coinbase.com";

// Глобальный Binance (здесь самая высокая активность в мире)
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";

const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;
const CHUNK_LIMIT = 300;

const historyStore = {};
const orderbookStore = {};
const tradesStore = {}; 
const latestPrice = {};

// === UTILS ===

// Превращаем BTC-USD в btcusdt (для глобального Binance)
function getBinanceSymbol(product) {
  return product.replace("-", "").toLowerCase() + "t"; 
}

function getCoinbaseSymbol(binanceStreamName) {
  const symbol = binanceStreamName.split("@")[0];
  return symbol.toUpperCase().replace("USDT", "-USD");
}

function mapCandlesFromCoinbase(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(c => ({
    time: Math.floor(c[0]),
    open: Number(c[3]),
    high: Number(c[2]),
    low: Number(c[1]),
    close: Number(c[4]),
  })).sort((a, b) => a.time - b.time);
}

function formatBinanceOrderBook(bids, asks) {
  const format = (arr) => arr.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  return { buy: format(bids), sell: format(asks) };
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  const pair = msg.pair;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      if (pair && ws.subscriptions && !ws.subscriptions.has(pair)) return;
      ws.send(text);
    }
  });
}

// === 1. HISTORY (COINBASE REST) ===
async function loadHistoryFor(product) {
  const now = Math.floor(Date.now() / 1000);
  let raw = [];
  try {
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}`;
    const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
    if (r.ok) {
      const chunk = await r.json();
      raw = chunk;
    }
  } catch (e) {
    console.error(`Error history ${product}:`, e.message);
  }
  historyStore[product] = mapCandlesFromCoinbase(raw).slice(-HISTORY_CANDLES);
}

// === 2. BINANCE WEBSOCKET (ГЛОБАЛЬНЫЙ) ===
let binanceWS;

function connectBinanceWS() {
  // Агрегированные сделки (aggTrade) — самый быстрый способ получать реальные продажи/покупки
  const streams = PRODUCTS.map(p => {
    const sym = getBinanceSymbol(p);
    return `${sym}@depth20@100ms/${sym}@aggTrade/${sym}@ticker`;
  }).join("/");

  const url = `${BINANCE_WS_BASE}${streams}`;
  console.log("Connecting to Global Binance...");
  
  binanceWS = new WebSocket(url);

  binanceWS.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.data || !msg.stream) return;

      const pair = getCoinbaseSymbol(msg.stream);
      const streamName = msg.stream.split("@")[1];

      // СТАКАН
      if (streamName.startsWith("depth")) {
        orderbookStore[pair] = formatBinanceOrderBook(msg.data.bids, msg.data.asks);
      }

      // ЦЕНА (летает очень быстро)
      else if (streamName === "ticker") {
        latestPrice[pair] = Number(msg.data.c);
        broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
      }

      // СДЕЛКИ (теперь их будет очень много)
      else if (streamName === "aggTrade") {
        if (!tradesStore[pair]) tradesStore[pair] = [];
        
        const trade = {
          price: Number(msg.data.p),
          size: Number(msg.data.q),
          side: msg.data.m ? "sell" : "buy",
          time: msg.data.T
        };

        tradesStore[pair].push(trade);
        if (tradesStore[pair].length > 50) tradesStore[pair].shift();
        
        // Отправляем массив из одной сделки (как ждет клиент)
        broadcast({ type: "trades", pair, trades: [trade] });
      }
    } catch (e) { console.error("Parse error:", e); }
  });

  binanceWS.on("close", () => setTimeout(connectBinanceWS, 2000));
}

// Рассылка стакана 5 раз в секунду
setInterval(() => {
  PRODUCTS.forEach(pair => {
    if (orderbookStore[pair]) {
      broadcast({ type: "orderBook", pair, ...orderbookStore[pair], ts: Date.now() });
    }
  });
}, 200);

// === 3. CLIENT WS SERVER ===
wss.on("connection", ws => {
  ws.subscriptions = new Set();
  ws.on("message", raw => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
        ws.subscriptions.add(data.pair);
        
        if (historyStore[data.pair]) ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        if (latestPrice[data.pair]) ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        if (orderbookStore[data.pair]) ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, ...orderbookStore[data.pair] }));
        if (tradesStore[data.pair]) ws.send(JSON.stringify({ type: "trades", pair: data.pair, trades: tradesStore[data.pair].slice(-20) }));
      }
    } catch (e) { console.error(e); }
  });
});

async function init() {
  for (const p of PRODUCTS) await loadHistoryFor(p);
  connectBinanceWS();
  server.listen(process.env.PORT || 3000, () => console.log(`🚀 Live Server on port 3000`));
}

init();

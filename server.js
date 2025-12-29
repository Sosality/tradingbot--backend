import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";

// =======================
// BASIC SERVER
// =======================
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// =======================
// CONFIG
// =======================
const PRODUCTS = ["BTC-USD", "ETH-USD"];

const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const BINANCE_WS = "wss://stream.binance.com:9443/ws";

// соответствие символов
const BINANCE_SYMBOL = {
  "BTC-USD": "btcusdt",
  "ETH-USD": "ethusdt"
};

const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;
const CHUNK_LIMIT = 300;

// =======================
// STORES
// =======================
const historyStore = {};
const tradesStore = {};
const latestPrice = {};
const orderbookStore = {}; // ← теперь Binance

// =======================
// UTILS
// =======================
function mapCandlesFromCoinbase(arr) {
  const map = new Map();
  for (const c of arr) {
    const t = Math.floor(c[0]);
    map.set(t, {
      time: t,
      open: Number(c[3]),
      high: Number(c[2]),
      low: Number(c[1]),
      close: Number(c[4])
    });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (msg.pair && ws.subscriptions && !ws.subscriptions.has(msg.pair)) return;
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

  while (fetched < HISTORY_CANDLES) {
    const to = now - fetched * GRANULARITY;
    const from = to - CHUNK_LIMIT * GRANULARITY;

    const url =
      `${COINBASE_REST}/products/${product}/candles` +
      `?granularity=${GRANULARITY}` +
      `&start=${new Date(from * 1000).toISOString()}` +
      `&end=${new Date(to * 1000).toISOString()}`;

    const r = await fetch(url);
    const chunk = await r.json();
    raw.push(...chunk);
    fetched += CHUNK_LIMIT;

    await new Promise(r => setTimeout(r, 250));
  }

  historyStore[product] = mapCandlesFromCoinbase(raw).slice(-HISTORY_CANDLES);
}

// =======================
// COINBASE WS (PRICE + TRADES)
// =======================
let coinbaseWS;

function connectCoinbaseWS() {
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open", () => {
    coinbaseWS.send(JSON.stringify({
      type: "subscribe",
      product_ids: PRODUCTS,
      channels: ["ticker", "matches"]
    }));
  });

  coinbaseWS.on("message", raw => {
    const m = JSON.parse(raw.toString());
    const pair = m.product_id;
    if (!PRODUCTS.includes(pair)) return;

    if (m.type === "ticker") {
      latestPrice[pair] = Number(m.price);
      broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
    }

    if (m.type === "match") {
      if (!tradesStore[pair]) tradesStore[pair] = [];
      tradesStore[pair].push({
        price: Number(m.price),
        size: Number(m.size),
        side: m.side,
        time: new Date(m.time).getTime()
      });
      if (tradesStore[pair].length > 100) tradesStore[pair].shift();
      broadcast({ type: "trades", pair, trades: tradesStore[pair].slice(-20) });
    }
  });

  coinbaseWS.on("close", () => {
    setTimeout(connectCoinbaseWS, 5000);
  });
}

// =======================
// BINANCE ORDER BOOK
// =======================
let binanceWS = {};

function connectBinanceOrderBook(pair) {
  const symbol = BINANCE_SYMBOL[pair];
  if (!symbol) return;

  if (binanceWS[pair]) binanceWS[pair].close();

  const url = `${BINANCE_WS}/${symbol}@depth20@100ms`;
  const ws = new WebSocket(url);
  binanceWS[pair] = ws;

  ws.on("message", raw => {
    const data = JSON.parse(raw.toString());
    orderbookStore[pair] = {
      buy: data.bids.map(([p, s]) => ({ price: Number(p), size: Number(s) })),
      sell: data.asks.map(([p, s]) => ({ price: Number(p), size: Number(s) }))
    };
  });

  ws.on("close", () => {
    setTimeout(() => connectBinanceOrderBook(pair), 1000);
  });
}

// =======================
// ORDERBOOK BROADCAST (200ms)
// =======================
setInterval(() => {
  PRODUCTS.forEach(pair => {
    const ob = orderbookStore[pair];
    if (!ob) return;
    broadcast({ type: "orderBook", pair, buy: ob.buy, sell: ob.sell, ts: Date.now() });
  });
}, 200);

// =======================
// CLIENT WS
// =======================
wss.on("connection", ws => {
  ws.subscriptions = new Set();

  ws.on("message", raw => {
    const data = JSON.parse(raw.toString());

    if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
      ws.subscriptions.add(data.pair);

      if (historyStore[data.pair])
        ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));

      if (latestPrice[data.pair])
        ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair] }));

      if (orderbookStore[data.pair])
        ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, ...orderbookStore[data.pair] }));
    }
  });
});

// =======================
// INIT
// =======================
(async () => {
  for (const p of PRODUCTS) {
    await loadHistoryFor(p);
    connectBinanceOrderBook(p);
  }
  connectCoinbaseWS();

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server running on ${port}`);
  });
})();

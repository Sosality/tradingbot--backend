// price-server.js
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

/**
 * CONFIG
 */
const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.pro.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const HISTORY_CANDLES = 1440; // целевых свечей (1d при 1m granularity)
const GRANULARITY = 60;       // 1 minute
const CHUNK_LIMIT = 300;      // максимум по одному запросу Coinbase

const historyStore = {};
const orderbookStore = {};
const tradesStore = {};
let latestPrice = {};

/** UTILS */
function mapCandlesFromCoinbase(arr){
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => ({
      time: Math.floor(item[0]), // epoch seconds
      open: Number(item[3]),
      high: Number(item[2]),
      low: Number(item[1]),
      close: Number(item[4])
    }))
    .sort((a,b) => a.time - b.time);
}

function createEmptyOrderbook(){ return { bids: new Map(), asks: new Map() }; }

function orderbookToArray(ob, side, limit = 50){
  const arr = [...(side === "buy" ? ob.bids.entries() : ob.asks.entries())]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }));
  if (side === "buy") arr.sort((a,b)=>b.price - a.price);
  else arr.sort((a,b)=>a.price - b.price);
  return arr.slice(0, limit);
}

function broadcast(msg){
  const text = JSON.stringify(msg);
  const pair = msg.pair;
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      const subs = client.subscriptions;
      if (pair && subs && subs.size > 0) {
        if (subs.has(pair)) client.send(text);
      } else {
        client.send(text);
      }
    } catch(e){}
  });
}

/** FETCH HISTORY — теперь собираем несколькими запросами, чтобы получить HISTORY_CANDLES */
async function loadHistoryFor(product){
  try {
    console.log(`Fetching history for ${product} ...`);
    const now = Math.floor(Date.now()/1000);
    const needed = HISTORY_CANDLES;
    const chunk = CHUNK_LIMIT;
    let collected = [];

    // We'll fetch chunks backwards from now
    let fetched = 0;
    while (fetched < needed) {
      const to = now - fetched * GRANULARITY;
      const from = to - (chunk * GRANULARITY);

      const startISO = new Date(from * 1000).toISOString();
      const endISO = new Date(to * 1000).toISOString();
      const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;

      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'TradeSim/1.0', 'Accept': 'application/json' }
        });

        if (!res.ok) {
          const txt = await res.text();
          console.warn(`History HTTP ${res.status} for ${product}: ${txt}`);
          break;
        }

        const arr = await res.json();
        // arr may be [] or up to CHUNK_LIMIT entries
        if (Array.isArray(arr) && arr.length > 0) {
          // Coinbase returns in descending time order often — push results
          collected = collected.concat(arr);
        }
      } catch (err) {
        console.warn("History fetch error:", err.message);
        break;
      }

      fetched += chunk;
      // small delay to be polite (avoid rate limits)
      await new Promise(r => setTimeout(r, 200));
    }

    // Map and dedupe/sort, then take latest HISTORY_CANDLES
    const mapped = mapCandlesFromCoinbase(collected);
    // keep last 'needed' candles (most recent)
    const latest = mapped.slice(-needed);
    historyStore[product] = latest;
    console.log(`Loaded history for ${product}: ${latest.length} candles`);
  } catch (err) {
    console.error(`History load error for ${product}:`, err.message);
    historyStore[product] = historyStore[product] || [];
  }
}

/** COINBASE WS */
let coinbaseWS = null;
function connectCoinbaseWS(){
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open", () => {
    console.log("Connected to Coinbase WS provider.");
    const subscribeMsg = {
      type: "subscribe",
      product_ids: PRODUCTS,
      channels: ["ticker", "level2", "matches"]
    };
    coinbaseWS.send(JSON.stringify(subscribeMsg));
  });

  coinbaseWS.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      handleCoinbaseMessage(msg);
    } catch (err) {
      console.error("WS parse err", err);
    }
  });

  coinbaseWS.on("close", () => {
    console.warn("Coinbase WS closed - reconnecting in 5s...");
    setTimeout(connectCoinbaseWS, 5000);
  });

  coinbaseWS.on("error", (e) => console.error("Coinbase WS error:", e.message));
}

function handleCoinbaseMessage(msg){
  if (!msg.type || !msg.product_id) return;
  const pair = msg.product_id;

  if (msg.type === "snapshot") {
    orderbookStore[pair] = createEmptyOrderbook();
    for (const [price, size] of msg.bids || []) {
      if (Number(size) > 0) orderbookStore[pair].bids.set(price, Number(size));
    }
    for (const [price, size] of msg.asks || []) {
      if (Number(size) > 0) orderbookStore[pair].asks.set(price, Number(size));
    }
    broadcast({
      type: "orderBook",
      pair,
      buy: orderbookToArray(orderbookStore[pair], "buy", 50),
      sell: orderbookToArray(orderbookStore[pair], "sell", 50)
    });
  } else if (msg.type === "l2update") {
    const changes = msg.changes || [];
    if (!orderbookStore[pair]) orderbookStore[pair] = createEmptyOrderbook();
    for (const [side, price, sizeStr] of changes){
      const size = Number(sizeStr);
      if (side === "buy") {
        if (size === 0) orderbookStore[pair].bids.delete(price);
        else orderbookStore[pair].bids.set(price, size);
      } else {
        if (size === 0) orderbookStore[pair].asks.delete(price);
        else orderbookStore[pair].asks.set(price, size);
      }
    }
    broadcast({
      type: "orderBook",
      pair,
      buy: orderbookToArray(orderbookStore[pair], "buy", 50),
      sell: orderbookToArray(orderbookStore[pair], "sell", 50)
    });
  } else if (msg.type === "ticker") {
    const price = Number(msg.price);
    latestPrice[pair] = price;
    broadcast({ type: "price", pair, price, ts: Date.now() });
  } else if (msg.type === "match" || msg.type === "matches") {
    const trade = {
      price: Number(msg.price),
      size: Number(msg.size),
      side: msg.side,
      time: new Date(msg.time).getTime()
    };
    tradesStore[pair] = tradesStore[pair] || [];
    tradesStore[pair].push(trade);
    if (tradesStore[pair].length > 500) tradesStore[pair].shift();
    broadcast({ type: "trades", pair, trades: tradesStore[pair].slice(-50) });
  }
}

/** INIT */
async function initAll(){
  for (const p of PRODUCTS) {
    historyStore[p] = [];
    orderbookStore[p] = createEmptyOrderbook();
    tradesStore[p] = [];
    latestPrice[p] = 0;
    await loadHistoryFor(p);
  }
  connectCoinbaseWS();
  setInterval(()=> {
    for (const p of PRODUCTS) {
      if (latestPrice[p]) broadcast({ type: "price", pair: p, price: latestPrice[p], ts: Date.now() });
    }
  }, 2000);
}

initAll().catch(e=>console.error("Init fatal error:", e));

/** CLIENT WS */
wss.on("connection", (ws) => {
  ws.subscriptions = new Set();
  console.log("Client connected (Front-end).");
  ws.send(JSON.stringify({ type: "hello", msg: "Server Ready", pairs: PRODUCTS }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe' && msg.pair) {
        const pair = msg.pair;
        ws.subscriptions.add(pair);

        const hist = historyStore[pair] || [];
        console.log(`Sending history for ${pair} to client (${hist.length} candles)`);
        ws.send(JSON.stringify({ type: "history", pair, data: hist }));

        if (latestPrice[pair]) ws.send(JSON.stringify({ type: "price", pair, price: latestPrice[pair] }));

        const ob = orderbookStore[pair];
        if (ob) {
            ws.send(JSON.stringify({
                type: "orderBook", pair,
                buy: orderbookToArray(ob, "buy", 50),
                sell: orderbookToArray(ob, "sell", 50)
            }));
        }

        if (tradesStore[pair]) {
            ws.send(JSON.stringify({ type: "trades", pair, trades: tradesStore[pair].slice(-50) }));
        }

      } else if (msg.type === 'unsubscribe' && msg.pair) {
        ws.subscriptions.delete(msg.pair);
      }
    } catch (err) {
      console.error("Client msg error:", err);
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=> console.log(`Price WS server running on port ${PORT}`));

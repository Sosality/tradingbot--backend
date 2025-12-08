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
 * Config
 */
const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.pro.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const historyStore = {};   // { 'BTC-USD': [ {time,open,high,low,close}, ... ] }
const orderbookStore = {}; // { 'BTC-USD': { bids: Map, asks: Map } }
const tradesStore = {};    // { 'BTC-USD': [ {price,size,side,time}, ... ] }
let latestPrice = {};      // { 'BTC-USD': 12345.67 }

/** Utils */
function mapCandlesFromCoinbase(arr){
  // Coinbase pro returns [ time, low, high, open, close, volume ]
  return arr
    .map(item => ({
      time: Math.floor(item[0]), // epoch seconds
      open: Number(item[3]),
      high: Number(item[2]),
      low: Number(item[1]),
      close: Number(item[4])
    }))
    .sort((a,b)=>a.time - b.time);
}
function createEmptyOrderbook(){ return { bids: new Map(), asks: new Map() }; }
function orderbookToArray(ob, side, limit = 50){
  const arr = [...(side === "buy" ? ob.bids.entries() : ob.asks.entries())]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }));
  if (side === "buy") arr.sort((a,b)=>b.price - a.price);
  else arr.sort((a,b)=>a.price - b.price);
  return arr.slice(0, limit);
}

/** Broadcast with subscription-aware filtering:
 *  If client has a non-empty ws.subscriptions Set, we only send pair-messages
 *  for pairs that are in that Set. If client.subscriptions is empty, it's treated
 *  as "no-filter" (backwards compatible).
 */
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
        // no pair or client has no subscriptions -> send
        client.send(text);
      }
    } catch(e){
      // ignore client send errors
    }
  });
}

/** Fetch historical candles (1m, limit 300) */
async function loadHistoryFor(product){
  try {
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=60&limit=300`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    historyStore[product] = mapCandlesFromCoinbase(arr);
    console.log(`Loaded history for ${product}, ${historyStore[product].length} candles`);
  } catch (err) {
    console.error("History load error for", product, err);
    historyStore[product] = historyStore[product] || [];
  }
}

/** Coinbase WS connection and handling */
let coinbaseWS = null;
function connectCoinbaseWS(){
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open", () => {
    console.log("Connected to Coinbase WS, subscribing...");
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
    console.warn("Coinbase WS closed - reconnect in 5s");
    setTimeout(connectCoinbaseWS, 5000);
  });

  coinbaseWS.on("error", (e) => {
    console.error("Coinbase WS error:", e && e.message ? e.message : e);
  });
}

function handleCoinbaseMessage(msg){
  const type = msg.type;
  if (!type) return;

  if (type === "snapshot" && msg.product_id) {
    const pair = msg.product_id;
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
  } else if (type === "l2update" && msg.product_id) {
    const pair = msg.product_id;
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
  } else if (type === "ticker" && msg.product_id) {
    const pair = msg.product_id;
    const price = Number(msg.price);
    latestPrice[pair] = price;
    broadcast({ type: "price", pair, price, ts: Date.now() });
  } else if ((type === "match" || type === "matches") && msg.product_id) {
    const trade = {
      price: Number(msg.price),
      size: Number(msg.size),
      side: msg.side,
      time: new Date(msg.time).getTime()
    };
    const pair = msg.product_id;
    tradesStore[pair] = tradesStore[pair] || [];
    tradesStore[pair].push(trade);
    if (tradesStore[pair].length > 500) tradesStore[pair].shift();
    broadcast({ type: "trades", pair, trades: tradesStore[pair].slice(-100) });
  }
}

/** Initialize stores and start */
async function initAll(){
  for (const p of PRODUCTS) {
    historyStore[p] = [];
    orderbookStore[p] = createEmptyOrderbook();
    tradesStore[p] = [];
    latestPrice[p] = 0;
    await loadHistoryFor(p);
  }
  connectCoinbaseWS();

  // Periodic heartbeat price broadcast (in case ticker missed)
  setInterval(()=> {
    for (const p of PRODUCTS) {
      if (latestPrice[p]) broadcast({ type: "price", pair: p, price: latestPrice[p], ts: Date.now() });
    }
  }, 2000);
}

initAll().catch(e=>console.error("init error", e));

/** WS connections: support per-client subscriptions */
wss.on("connection", (ws) => {
  ws.subscriptions = new Set(); // if empty -> no-filter (client sees broadcasts)
  console.log("Client connected to price WS, waiting for subscribe messages.");

  // Send hello with available pairs
  ws.send(JSON.stringify({ type: "hello", msg: "price-ws OK", pairs: PRODUCTS }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'subscribe' && msg.pair) {
        const pair = msg.pair;
        ws.subscriptions.add(pair);
        // send immediate snapshot for that pair
        const hist = historyStore[pair] || [];
        if (hist.length) ws.send(JSON.stringify({ type: "history", pair, data: hist }));
        const ob = orderbookStore[pair] || createEmptyOrderbook();
        ws.send(JSON.stringify({
          type: "orderBook",
          pair,
          buy: orderbookToArray(ob, "buy", 50),
          sell: orderbookToArray(ob, "sell", 50)
        }));
        ws.send(JSON.stringify({ type: "trades", pair, trades: tradesStore[pair] || [] }));
        if (latestPrice[pair]) ws.send(JSON.stringify({ type: "price", pair, price: latestPrice[pair] }));
      } else if (msg && msg.type === 'unsubscribe' && msg.pair) {
        ws.subscriptions.delete(msg.pair);
      }
    } catch (err) {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected (price WS)");
  });
});

/** Simple HTTP endpoints */
app.get("/health", (req,res)=>res.json({ ok: true }));
app.get("/price", (req,res)=> res.json({ price: latestPrice, pairs: PRODUCTS }));
app.get("/history/:pair", (req,res)=>{
  const pair = req.params.pair;
  res.json({ pair, candles: historyStore[pair] || [] });
});

/** Start server */
const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=> console.log(`Price WS server running on port ${PORT}`));

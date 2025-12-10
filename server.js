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

const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;
const CHUNK_LIMIT = 300;

const historyStore = {};
const orderbookStore = {};
const tradesStore = {};
let latestPrice = {};

/** ===== UTILS ===== */
function mapCandlesFromCoinbase(arr){
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

  return [...map.values()].sort((a,b)=>a.time - b.time);
}

function createEmptyOrderbook(){ return { bids: new Map(), asks: new Map() }; }

function orderbookToArray(ob, side, limit = 50){
  const arr = [...(side === "buy" ? ob.bids : ob.asks).entries()]
    .map(([price,size])=>({price:Number(price),size:Number(size)}));

  arr.sort((a,b)=> side==="buy" ? b.price-a.price : a.price-b.price);
  return arr.slice(0,limit);
}

function broadcast(msg){
  const text = JSON.stringify(msg);
  const pair = msg.pair;

  wss.clients.forEach(ws=>{
    if (ws.readyState !== WebSocket.OPEN) return;
    if (pair && ws.subscriptions && !ws.subscriptions.has(pair)) return;
    ws.send(text);
  });
}

/** ===== HISTORY ===== */
async function loadHistoryFor(product){
  console.log(`Fetching history for ${product} ...`);
  const now = Math.floor(Date.now()/1000);
  const total = HISTORY_CANDLES;
  const chunk = CHUNK_LIMIT;
  let raw = [];

  let fetched = 0;
  while (fetched < total){
    const to = now - fetched*GRANULARITY;
    const from = to - chunk*GRANULARITY;

    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}&start=${new Date(from*1000).toISOString()}&end=${new Date(to*1000).toISOString()}`;

    const r = await fetch(url, { headers: { "Accept":"application/json" } });
    if (!r.ok) break;

    const data = await r.json();
    raw.push(...data);
    fetched += chunk;

    await new Promise(r=>setTimeout(r,200));
  }

  const candles = mapCandlesFromCoinbase(raw).slice(-total);
  historyStore[product] = candles;
  console.log(`Loaded history for ${product}: ${candles.length}`);
}

/** ===== COINBASE WS ===== */
let coinbaseWS;

function connectCoinbaseWS(){
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open",()=>{
    console.log("Connected to Coinbase WS provider");
    coinbaseWS.send(JSON.stringify({
      type:"subscribe",
      product_ids:PRODUCTS,
      channels:["ticker","level2","matches"]
    }));
  });

  coinbaseWS.on("message",(raw)=>{
    const msg = JSON.parse(raw.toString());
    handleCoinbaseMessage(msg);
  });

  coinbaseWS.on("close",()=>setTimeout(connectCoinbaseWS,5000));
  coinbaseWS.on("error",()=>{});
}

function handleCoinbaseMessage(m){
  const pair = m.product_id;
  if (!pair) return;

  if (m.type==="ticker"){
    const price = Number(m.price);
    latestPrice[pair] = price;
    broadcast({ type:"price", pair, price, ts: Date.now() });
  }

  if (m.type==="l2update" || m.type==="snapshot"){
    if (!orderbookStore[pair]) orderbookStore[pair]=createEmptyOrderbook();
    const ob = orderbookStore[pair];

    (m.bids||[]).forEach(([p,s])=>{
      s==0 ? ob.bids.delete(p) : ob.bids.set(p,Number(s));
    });
    (m.asks||[]).forEach(([p,s])=>{
      s==0 ? ob.asks.delete(p) : ob.asks.set(p,Number(s));
    });

    if (m.changes){
      m.changes.forEach(([side,price,size])=>{
        const s = Number(size);
        if (side=="buy") s==0?ob.bids.delete(price):ob.bids.set(price,s);
        else s==0?ob.asks.delete(price):ob.asks.set(price,s);
      });
    }

    broadcast({
      type:"orderBook",
      pair,
      buy:orderbookToArray(ob,"buy",50),
      sell:orderbookToArray(ob,"sell",50)
    });
  }

  if (m.type==="match" || m.type==="matches"){
    if (!tradesStore[pair]) tradesStore[pair]=[];
    tradesStore[pair].push({
      price:Number(m.price),
      size:Number(m.size),
      side:m.side,
      time:new Date(m.time).getTime()
    });

    if (tradesStore[pair].length>500) tradesStore[pair].shift();

    broadcast({ type:"trades", pair, trades: tradesStore[pair].slice(-50) });
  }
}

/** ===== INIT ===== */
async function init(){
  for (const p of PRODUCTS){
    historyStore[p]=[];
    orderbookStore[p]=createEmptyOrderbook();
    tradesStore[p]=[];
    latestPrice[p]=0;
    await loadHistoryFor(p);
  }
  connectCoinbaseWS();
}

init();

wss.on("connection",(ws)=>{
  ws.subscriptions=new Set();
  ws.send(JSON.stringify({type:"hello"}));

  ws.on("message",raw=>{
    const msg = JSON.parse(raw.toString());

    if (msg.type==="subscribe"){
      const pair = msg.pair;
      ws.subscriptions.add(pair);

      ws.send(JSON.stringify({
        type:"history",
        pair,
        data:historyStore[pair]||[]
      }));

      if (latestPrice[pair]) ws.send(JSON.stringify({
        type:"price", pair, price:latestPrice[pair]
      }));
    }

    if (msg.type==="unsubscribe"){
      ws.subscriptions.delete(msg.pair);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT,()=>console.log("Price WS server running on",PORT));

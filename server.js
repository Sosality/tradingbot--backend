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

// =======================
// ХРАНИЛИЩА
// =======================
const historyStore = {};
const orderbookStore = {};
const tradesStore = {};
const latestPrice = {};

const orderbookSeq = {};
const lastOBHash = {};
// [FIX] Флаг, чтобы не скачивать стакан много раз одновременно
const isSyncing = {}; 

// =======================
// UTILS
// =======================
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

function createEmptyOrderbook(){
  return { bids: new Map(), asks: new Map() };
}

function orderbookToArray(ob, side, limit = 15){
  const arr = [...(side === "buy" ? ob.bids : ob.asks).entries()]
    .map(([price,size])=>({price:Number(price),size:Number(size)}));

  arr.sort((a,b)=> side==="buy" ? b.price - a.price : a.price - b.price);
  return arr.slice(0,limit);
}

function hashOB(buy, sell){
  return (
    buy.map(l=>`${l.price}:${l.size}`).join("|") +
    sell.map(l=>`${l.price}:${l.size}`).join("|")
  );
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

// =======================
// HISTORY + SNAPSHOT
// =======================
async function loadHistoryFor(product){
  const now = Math.floor(Date.now()/1000);
  let raw = [];
  let fetched = 0;

  while (fetched < HISTORY_CANDLES){
    const to = now - fetched*GRANULARITY;
    const from = to - CHUNK_LIMIT*GRANULARITY;
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}&start=${new Date(from*1000).toISOString()}&end=${new Date(to*1000).toISOString()}`;
    const r = await fetch(url);
    if (!r.ok) break;
    const json = await r.json();
    if(!Array.isArray(json)) break;
    
    raw.push(...json);
    fetched += CHUNK_LIMIT;
    await new Promise(r=>setTimeout(r,200));
  }

  historyStore[product] = mapCandlesFromCoinbase(raw).slice(-HISTORY_CANDLES);
  console.log(`Loaded history for ${product}: ${historyStore[product].length} candles`);
}

async function loadOrderBookSnapshot(product){
  console.log(`Loading Snapshot for ${product}...`);
  const url = `${COINBASE_REST}/products/${product}/book?level=2`;
  try {
      const r = await fetch(url);
      if (!r.ok) {
          console.error(`Failed to load snapshot ${product}: ${r.status}`);
          return;
      }

      const data = await r.json();
      const ob = createEmptyOrderbook();

      // Ограничиваем глубину хранения, чтобы не забивать память
      data.bids.slice(0,500).forEach(([p,s])=>ob.bids.set(String(p),Number(s)));
      data.asks.slice(0,500).forEach(([p,s])=>ob.asks.set(String(p),Number(s)));

      orderbookStore[product] = ob;
      orderbookSeq[product] = data.sequence || 0;
      console.log(`Snapshot loaded for ${product}, seq: ${data.sequence}`);
  } catch (e) {
      console.error("Snapshot Error:", e);
  }
}

// =======================
// COINBASE WS
// =======================
let coinbaseWS;

function connectCoinbaseWS(){
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open",()=>{
    console.log("Connected to Coinbase WS");
    coinbaseWS.send(JSON.stringify({
      type:"subscribe",
      product_ids:PRODUCTS,
      channels:["ticker","level2","matches"]
    }));
  });

  coinbaseWS.on("message",raw=>{
    try {
        handleCoinbaseMessage(JSON.parse(raw.toString()));
    } catch(e) {
        console.error("Parse error:", e);
    }
  });

  coinbaseWS.on("close",()=>{
      console.log("Coinbase WS Closed. Reconnecting...");
      setTimeout(connectCoinbaseWS,5000);
  });
  
  coinbaseWS.on("error", (err) => console.error("Coinbase WS Error:", err));
}

async function handleCoinbaseMessage(m){
  const pair = m.product_id;
  if (!pair) return;

  // PRICE
  if (m.type==="ticker"){
    latestPrice[pair] = Number(m.price);
    broadcast({ type:"price", pair, price:latestPrice[pair], ts:Date.now() });
  }

  // ORDERBOOK UPDATE
  if (m.type==="l2update"){
    if (!orderbookStore[pair]) return;

    // [FIX] Если уже идет синхронизация - пропускаем апдейты, чтобы не спамить
    if (isSyncing[pair]) return;

    // Проверка sequence
    if (m.sequence <= orderbookSeq[pair]) return; // Старый пакет

    if (m.sequence !== orderbookSeq[pair] + 1){
      console.log(`[${pair}] Sequence gap! Expected ${orderbookSeq[pair] + 1}, got ${m.sequence}. Resyncing...`);
      
      isSyncing[pair] = true; // Ставим блокировку
      await loadOrderBookSnapshot(pair);
      isSyncing[pair] = false; // Снимаем блокировку
      return;
    }
    
    orderbookSeq[pair] = m.sequence;

    const ob = orderbookStore[pair];
    m.changes.forEach(([side,price,size])=>{
      const p = String(price);
      const s = Number(size);
      if (side==="buy"){
        s===0 ? ob.bids.delete(p) : ob.bids.set(p,s);
      } else {
        s===0 ? ob.asks.delete(p) : ob.asks.set(p,s);
      }
    });
  }

  // TRADES
  if (m.type==="match"){
    if (!tradesStore[pair]) tradesStore[pair]=[];
    tradesStore[pair].push({
      price:Number(m.price),
      size:Number(m.size),
      side:m.side,
      time:new Date(m.time).getTime()
    });
    if (tradesStore[pair].length>100) tradesStore[pair].shift();
    broadcast({ type:"trades", pair, trades: tradesStore[pair].slice(-20) });
  }
}

// =======================
// ORDERBOOK BROADCAST (200ms)
// =======================
setInterval(()=>{
  PRODUCTS.forEach(pair=>{
    const ob = orderbookStore[pair];
    if (!ob) return;

    // Берем топ-15 для отправки клиенту
    const buy = orderbookToArray(ob,"buy",15);
    const sell = orderbookToArray(ob,"sell",15);
    
    if (!buy.length && !sell.length) return;

    const h = hashOB(buy,sell);
    if (h === lastOBHash[pair]) return; // Если ничего не изменилось - не отправляем
    lastOBHash[pair] = h;

    broadcast({ type:"orderBook", pair, buy, sell });
  });
}, 200);

// =======================
// WS SERVER
// =======================
wss.on("connection",ws=>{
  ws.subscriptions = new Set();

  ws.on("message",msg=>{
    try {
        const data = JSON.parse(msg);
        if (data.type==="subscribe"){
          const pair = data.pair;
          ws.subscriptions.add(pair);
          
          // Сразу отправляем данные, которые есть в памяти
          if (historyStore[pair]) ws.send(JSON.stringify({ type:"history", pair, data:historyStore[pair] }));
          if (latestPrice[pair]) ws.send(JSON.stringify({ type:"price", pair, price:latestPrice[pair], ts:Date.now() }));
          
          if (orderbookStore[pair]) {
             const ob = orderbookStore[pair];
             ws.send(JSON.stringify({
                type:"orderBook",
                pair,
                buy:orderbookToArray(ob,"buy",15),
                sell:orderbookToArray(ob,"sell",15)
             }));
          }
        }
    } catch (e) {
        console.error("Client msg error:", e);
    }
  });
});

// =======================
// INIT
// =======================
async function init(){
  console.log("Server starting...");
  for (const p of PRODUCTS){
    await Promise.all([
      loadHistoryFor(p),
      loadOrderBookSnapshot(p)
    ]);
  }
  connectCoinbaseWS();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

init();

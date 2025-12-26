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

// Хранилище данных
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

function orderbookToArray(ob, side, limit = 15){
  // Превращаем Map в массив
  const arr = [...(side === "buy" ? ob.bids : ob.asks).entries()]
    .map(([price,size])=>({price:Number(price),size:Number(size)}));
  
  // Сортировка: Bids (покупатели) по убыванию, Asks (продавцы) по возрастанию
  arr.sort((a,b)=> side==="buy" ? b.price - a.price : a.price - b.price);
  
  return arr.slice(0,limit);
}

function broadcast(msg){
  const text = JSON.stringify(msg);
  const pair = msg.pair;
  wss.clients.forEach(ws=>{
    if (ws.readyState !== WebSocket.OPEN) return;
    // Если клиент подписан на эту пару — отправляем
    if (pair && ws.subscriptions && !ws.subscriptions.has(pair)) return;
    ws.send(text);
  });
}

/** ===== HISTORY & SNAPSHOT ===== */
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
    
    try {
      const r = await fetch(url, { headers: { "Accept":"application/json" } });
      if (!r.ok) break;
      const data = await r.json();
      raw.push(...data);
    } catch(e) {
      console.error("Error fetching chunk:", e);
      break;
    }
    fetched += chunk;
    await new Promise(r=>setTimeout(r,200));
  }

  const candles = mapCandlesFromCoinbase(raw).slice(-total);
  historyStore[product] = candles;
  console.log(`Loaded history for ${product}: ${candles.length}`);
}

async function loadOrderBookSnapshot(product) {
    console.log(`Fetching OrderBook Snapshot for ${product}...`);
    // Берем сразу level=2, чтобы получить основу
    const url = `${COINBASE_REST}/products/${product}/book?level=2`;
    
    try {
        const r = await fetch(url, { headers: { "User-Agent": "TradeSim/1.0", "Accept": "application/json" } });
        if (!r.ok) {
            console.error(`Failed to load snapshot for ${product}: ${r.statusText}`);
            return;
        }
        const data = await r.json();
        
        if (!orderbookStore[product]) orderbookStore[product] = createEmptyOrderbook();
        const ob = orderbookStore[product];
        
        // Очищаем и заполняем заново
        ob.bids.clear();
        ob.asks.clear();

        if (Array.isArray(data.bids)) {
            data.bids.forEach(bid => ob.bids.set(String(bid[0]), Number(bid[1])));
        }
        if (Array.isArray(data.asks)) {
            data.asks.forEach(ask => ob.asks.set(String(ask[0]), Number(ask[1])));
        }

        console.log(`Snapshot loaded for ${product}: ${ob.bids.size} bids, ${ob.asks.size} asks`);
    } catch (e) {
        console.error(`Error loading snapshot for ${product}:`, e);
    }
}

/** ===== COINBASE WS ===== */
let coinbaseWS;

function connectCoinbaseWS(){
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open",()=>{
    console.log("Connected to Coinbase WS");
    coinbaseWS.send(JSON.stringify({
      type:"subscribe",
      product_ids:PRODUCTS,
      channels:["ticker", "level2", "matches"]
    }));
  });

  coinbaseWS.on("message",(raw)=>{
    try {
      const msg = JSON.parse(raw.toString());
      handleCoinbaseMessage(msg);
    } catch(e){
      console.error("Parse error", e);
    }
  });

  coinbaseWS.on("close",()=>setTimeout(connectCoinbaseWS,5000));
  coinbaseWS.on("error",(e)=>console.error("Coinbase WS error:", e));
}

function handleCoinbaseMessage(m){
  const pair = m.product_id;
  if (!pair) return;

  // 1. Ticker (Цена)
  if (m.type==="ticker"){
    const price = Number(m.price);
    latestPrice[pair] = price;

    if (historyStore[pair] && historyStore[pair].length > 0) {
      const candles = historyStore[pair];
      const lastCandle = candles[candles.length - 1];
      const now = Math.floor(Date.now() / 1000);
      const currentMinute = now - (now % 60);

      if (lastCandle.time === currentMinute) {
        lastCandle.close = price;
        if (price > lastCandle.high) lastCandle.high = price;
        if (price < lastCandle.low) lastCandle.low = price;
      } else if (currentMinute > lastCandle.time) {
        candles.push({ time: currentMinute, open: lastCandle.close, high: price, low: price, close: price });
        if (candles.length > HISTORY_CANDLES + 500) candles.shift();
      }
    }
    // Тикер можно слать сразу, он не такой частый как стакан
    broadcast({ type:"price", pair, price, ts: Date.now() });
  }

  // 2. Orderbook Updates (ОБНОВЛЕНИЕ ПАМЯТИ)
  // ВНИМАНИЕ: Здесь мы ТОЛЬКО обновляем память, но НЕ отправляем данные клиенту (Broadcast)
  // Отправка будет происходить в отдельном интервале (см. ниже)
  if (m.type === "l2update"){
    if (!orderbookStore[pair]) orderbookStore[pair] = createEmptyOrderbook();
    const ob = orderbookStore[pair];

    if (m.changes){
      m.changes.forEach(([side, price, size]) => {
        const s = Number(size);
        const p = String(price); 
        
        if (side === "buy") {
            if (s === 0) ob.bids.delete(p);
            else ob.bids.set(p, s);
        } else {
            if (s === 0) ob.asks.delete(p);
            else ob.asks.set(p, s);
        }
      });
    }
  }

  // Snapshot от сокета (редкость, но бывает)
  if (m.type === "snapshot") {
      if (!orderbookStore[pair]) orderbookStore[pair] = createEmptyOrderbook();
      const ob = orderbookStore[pair];
      ob.bids.clear();
      ob.asks.clear();
      if (m.bids) m.bids.forEach(([p, s]) => ob.bids.set(String(p), Number(s)));
      if (m.asks) m.asks.forEach(([p, s]) => ob.asks.set(String(p), Number(s)));
  }

  // 3. Trades
  if (m.type==="match" || m.type==="last_match"){
    if (!tradesStore[pair]) tradesStore[pair]=[];
    tradesStore[pair].push({
      price:Number(m.price),
      size:Number(m.size),
      side:m.side,
      time:new Date(m.time).getTime()
    });
    if (tradesStore[pair].length>100) tradesStore[pair].shift();
    // Сделки тоже шлем сразу, они нужны для ленты
    broadcast({ type:"trades", pair, trades: tradesStore[pair].slice(-20) });
  }
}

/** ===== INTERVAL BROADCAST (THROTTLING) ===== */
// [ВАЖНО] Отправляем стакан раз в 200мс, чтобы не "убить" браузер
setInterval(() => {
    PRODUCTS.forEach(pair => {
        if (orderbookStore[pair]) {
            const ob = orderbookStore[pair];
            // Проверяем, есть ли данные вообще
            if (ob.bids.size > 0 || ob.asks.size > 0) {
                 broadcast({
                    type: "orderBook",
                    pair: pair,
                    buy: orderbookToArray(ob, "buy", 15), 
                    sell: orderbookToArray(ob, "sell", 15)
                });
            }
        }
    });
}, 200); // 5 раз в секунду — более чем достаточно для глаз

/** ===== WS SERVER ===== */
wss.on('connection', (ws) => {
    ws.subscriptions = new Set();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'subscribe' && data.pair) {
                ws.subscriptions.add(data.pair);
                
                // 1. История
                if (historyStore[data.pair]) {
                    ws.send(JSON.stringify({ type: 'history', pair: data.pair, data: historyStore[data.pair] }));
                }
                
                // 2. Текущий стакан (сразу)
                if (orderbookStore[data.pair]) {
                    const ob = orderbookStore[data.pair];
                    ws.send(JSON.stringify({
                        type: "orderBook",
                        pair: data.pair,
                        buy: orderbookToArray(ob, "buy", 15),
                        sell: orderbookToArray(ob, "sell", 15)
                    }));
                }

                // 3. Сделки
                 if (tradesStore[data.pair]) {
                    ws.send(JSON.stringify({ type:"trades", pair: data.pair, trades: tradesStore[data.pair].slice(-20) }));
                 }
                 
                // 4. Цена
                if (latestPrice[data.pair]) {
                    ws.send(JSON.stringify({ type:"price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
                }
            }

            if (data.type === 'unsubscribe' && data.pair) {
                ws.subscriptions.delete(data.pair);
            }
        } catch (e) {
            console.error('Client msg error', e);
        }
    });
});

async function init(){
  // Сначала загружаем данные, потом открываем сокет
  for (const p of PRODUCTS){
    historyStore[p]=[];
    orderbookStore[p]=createEmptyOrderbook();
    await Promise.all([
        loadHistoryFor(p),
        loadOrderBookSnapshot(p)
    ]);
  }
  
  connectCoinbaseWS();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT,()=>{ console.log(`Server started on port ${PORT}`); });
}

init();

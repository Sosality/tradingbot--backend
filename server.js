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
    // Если клиент подписан на пару, отправляем ему данные
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

// === ГЛАВНАЯ ЛОГИКА ОБНОВЛЕНИЯ ===
function handleCoinbaseMessage(m){
  const pair = m.product_id;
  if (!pair) return;

  // 1. Ticker / Price update
  if (m.type==="ticker"){
    const price = Number(m.price);
    latestPrice[pair] = price;

    // --- ФИКС: ОБНОВЛЯЕМ ИСТОРИЮ НА СЕРВЕРЕ ---
    if (historyStore[pair] && historyStore[pair].length > 0) {
      const candles = historyStore[pair];
      const lastCandle = candles[candles.length - 1];
      
      const now = Math.floor(Date.now() / 1000);
      const currentMinute = now - (now % 60);

      if (lastCandle.time === currentMinute) {
        // Обновляем текущую свечу
        lastCandle.close = price;
        if (price > lastCandle.high) lastCandle.high = price;
        if (price < lastCandle.low) lastCandle.low = price;
      } else if (currentMinute > lastCandle.time) {
        // Создаем новую свечу
        const newCandle = {
          time: currentMinute,
          open: lastCandle.close, // continuity
          high: price,
          low: price,
          close: price
        };
        candles.push(newCandle);

        // Ограничиваем размер истории, чтобы память не текла
        if (candles.length > HISTORY_CANDLES + 500) {
          candles.shift();
        }
      }
    }
    // ------------------------------------------

    broadcast({ type:"price", pair, price, ts: Date.now() });
  }

  // 2. Orderbook update
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

    // Для экономии трафика можно броадкастить orderbook реже, 
    // но пока оставим как есть для плавности
    broadcast({
      type:"orderBook",
      pair,
      buy:orderbookToArray(ob,"buy",20), // шлем только топ-20
      sell:orderbookToArray(ob,"sell",20)
    });
  }

  // 3. Trades update
  if (m.type==="match" || m.type==="matches"){
    if (!tradesStore[pair]) tradesStore[pair]=[];
    tradesStore[pair].push({
      price:Number(m.price),
      size:Number(m.size),
      side:m.side,
      time:new Date(m.time).getTime()
    });

    if (tradesStore[pair].length>100) tradesStore[pair].shift(); // храним меньше
    broadcast({ type:"trades", pair, trades: tradesStore[pair].slice(-20) });
  }
}

/** ===== WS CONNECTION HANDLING ===== */
// Обработка подключений клиентов
wss.on('connection', (ws) => {
    ws.subscriptions = new Set(); // Храним подписки клиента

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'subscribe' && data.pair) {
                ws.subscriptions.add(data.pair);
                
                // Сразу отправляем историю
                if (historyStore[data.pair]) {
                    ws.send(JSON.stringify({
                        type: 'history',
                        pair: data.pair,
                        data: historyStore[data.pair]
                    }));
                }
                
                // Сразу отправляем текущий стакан
                /* Можно раскомментировать, если нужно мгновенное отображение стакана
                if (orderbookStore[data.pair]) {
                   // логика отправки snapshot стакана
                }
                */
            }

            if (data.type === 'unsubscribe' && data.pair) {
                ws.subscriptions.delete(data.pair);
            }

        } catch (e) {
            console.error('Client msg error', e);
        }
    });
});

/** ===== INIT ===== */
async function init(){
  for (const p of PRODUCTS){
    historyStore[p]=[];
    orderbookStore[p]=createEmptyOrderbook();
    await loadHistoryFor(p);
  }
  connectCoinbaseWS();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT,()=>{
    console.log(`Server started on port ${PORT}`);
  });
}

init();

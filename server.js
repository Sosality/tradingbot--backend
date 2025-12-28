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

// =======================
// UTILS
// =======================
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

function createEmptyOrderbook() {
  return { bids: new Map(), asks: new Map() };
}

function orderbookToArray(ob, side, limit = 15) {
  const arr = [...(side === "buy" ? ob.bids : ob.asks).entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }));
  arr.sort((a, b) => (side === "buy" ? b.price - a.price : a.price - b.price));
  return arr.slice(0, limit);
}

function hashOB(buy, sell) {
  return (
    buy.map(l => `${l.price}:${l.size}`).join("|") +
    "|" +
    sell.map(l => `${l.price}:${l.size}`).join("|")
  );
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  const pair = msg.pair;
  let sentCount = 0;
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (pair && ws.subscriptions && !ws.subscriptions.has(pair)) return;
    ws.send(text);
    sentCount++;
  });
  if (msg.type === "orderBook") {
    console.log(`📶 orderBook broadcast sent to ${sentCount} clients for ${pair}`);
  }
}

// =======================
// HISTORY + SNAPSHOT
// =======================
async function loadHistoryFor(product) {
  const now = Math.floor(Date.now() / 1000);
  let raw = [];
  let fetched = 0;
  while (fetched < HISTORY_CANDLES) {
    const to = now - fetched * GRANULARITY;
    const from = to - CHUNK_LIMIT * GRANULARITY;
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}&start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
      if (!r.ok) {
        console.warn(`Failed to fetch candles for ${product}: ${r.status}`);
        break;
      }
      const chunk = await r.json();
      raw.push(...chunk);
      fetched += CHUNK_LIMIT;
      await new Promise(r => setTimeout(r, 250)); // уважение к rate limit
    } catch (e) {
      console.error(`Error fetching history for ${product}:`, e.message);
      break;
    }
  }
  historyStore[product] = mapCandlesFromCoinbase(raw).slice(-HISTORY_CANDLES);
}

async function loadOrderBookSnapshot(product) {
  const url = `${COINBASE_REST}/products/${product}/book?level=2`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
    if (!r.ok) {
      console.warn(`Failed to fetch orderbook snapshot for ${product}: ${r.status}`);
      return false;
    }
    const data = await r.json();
    const ob = createEmptyOrderbook();
    data.bids.slice(0, 500).forEach(([p, s]) => ob.bids.set(String(p), Number(s)));
    data.asks.slice(0, 500).forEach(([p, s]) => ob.asks.set(String(p), Number(s)));

    orderbookStore[product] = ob;
    orderbookSeq[product] = data.sequence || 0;
    lastOBHash[product] = ""; // сбрасываем хэш, чтобы отправить свежий стакан
    console.log(`✅ Orderbook snapshot loaded for ${product} (seq=${orderbookSeq[product]})`);
    return true;
  } catch (e) {
    console.error(`Error loading snapshot for ${product}:`, e.message);
    return false;
  }
}

// =======================
// COINBASE WS
// =======================
let coinbaseWS;

function connectCoinbaseWS() {
  console.log("Connecting to Coinbase WebSocket...");
  coinbaseWS = new WebSocket(COINBASE_WS);

  coinbaseWS.on("open", () => {
    console.log("Coinbase WS connected — subscribing to channels...");
    coinbaseWS.send(JSON.stringify({
      type: "subscribe",
      product_ids: PRODUCTS,
      channels: ["ticker", "level2", "matches"]
    }));

    // Важно: перезагружаем снапшоты при каждом reconnect
    PRODUCTS.forEach(p => loadOrderBookSnapshot(p));
  });

  coinbaseWS.on("message", raw => {
    try {
      const m = JSON.parse(raw.toString());
      handleCoinbaseMessage(m);
    } catch (e) {
      console.error("Error parsing Coinbase message:", e);
    }
  });

  coinbaseWS.on("close", () => {
    console.log("Coinbase WS closed — reconnecting in 5s...");
    setTimeout(connectCoinbaseWS, 5000);
  });

  coinbaseWS.on("error", err => {
    console.error("Coinbase WS error:", err.message);
  });
}

async function handleCoinbaseMessage(m) {
  const pair = m.product_id;
  if (!PRODUCTS.includes(pair)) return;

  // 1. ЦЕНА
  if (m.type === "ticker") {
    latestPrice[pair] = Number(m.price);
    broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
    return;
  }

  // 2. СДЕЛКИ
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
    return;
  }

  // 3. ORDERBOOK — L2UPDATE
  if (m.type === "l2update") {
    if (!orderbookStore[pair]) {
      console.log(`No orderbook for ${pair} — loading snapshot`);
      await loadOrderBookSnapshot(pair);
      return;
    }

    const ob = orderbookStore[pair];

    m.changes.forEach(([side, price, size]) => {
      const p = String(price);
      const s = Number(size);

      if (side === "buy") {
        if (s === 0) ob.bids.delete(p);
        else ob.bids.set(p, s);
      } else {
        if (s === 0) ob.asks.delete(p);
        else ob.asks.set(p, s);
      }
    });

    // ❗ НЕ ТРОГАЕМ sequence
    lastOBHash[pair] = "";
    return;
  }

  // 4. СНАПШОТ (если вдруг придёт по WS)
  if (m.type === "snapshot") {
    const ob = createEmptyOrderbook();
    m.bids.forEach(([p, s]) => ob.bids.set(String(p), Number(s)));
    m.asks.forEach(([p, s]) => ob.asks.set(String(p), Number(s)));
    orderbookStore[pair] = ob;
    orderbookSeq[pair] = -1;
    lastOBHash[pair] = "";
    console.log(`WS Snapshot received for ${pair}`);
  }
}

// =======================
// ORDERBOOK BROADCAST (каждые 200ms)
// =======================
setInterval(() => {
  PRODUCTS.forEach(pair => {
    const ob = orderbookStore[pair];
    if (!ob) {
      // console.log(`No orderbook for ${pair}`);
      return;
    }

    const buy = orderbookToArray(ob, "buy", 15);
    const sell = orderbookToArray(ob, "sell", 15);

    const h = hashOB(buy, sell);
    //if (h === lastOBHash[pair]) {
      //return; // изменений нет
    //}

    lastOBHash[pair] = h;
    console.log(`📤 Sending orderBook update for ${pair}: ${buy.length} bids, ${sell.length} asks`);
    broadcast({ type: "orderBook", pair, buy, sell });
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
      if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
        ws.subscriptions.add(data.pair);
        console.log(`Client subscribed to ${data.pair}`);

        // Отправляем историю
        if (historyStore[data.pair]) {
          ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        }

        // Отправляем текущую цену
        if (latestPrice[data.pair]) {
          ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        }

        // КРИТИЧНО: отправляем стакан, даже если он ещё не готов — или ждём его
        if (orderbookStore[data.pair]) {
          const buy = orderbookToArray(orderbookStore[data.pair], "buy", 15);
          const sell = orderbookToArray(orderbookStore[data.pair], "sell", 15);
          ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, buy, sell }));
        } else {
          // Если стакана нет — ждём 2 секунды и пробуем снова (снапшот может быть в процессе загрузки)
          setTimeout(() => {
            if (orderbookStore[data.pair]) {
              const buy = orderbookToArray(orderbookStore[data.pair], "buy", 15);
              const sell = orderbookToArray(orderbookStore[data.pair], "sell", 15);
              ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, buy, sell }));
              console.log(`Delayed orderBook sent to client for ${data.pair}`);
            }
          }, 2000);
        }
      }
    } catch (e) {
      console.error("Error handling client message:", e);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

// =======================
// INIT
// =======================
async function init() {
  console.log("Initializing TradeSim server...");
  for (const p of PRODUCTS) {
    await Promise.all([
      loadHistoryFor(p),
      loadOrderBookSnapshot(p)
    ]);
  }
  connectCoinbaseWS();
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

init();

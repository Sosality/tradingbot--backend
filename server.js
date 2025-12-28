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

// ========== ORDERBOOK UTILS (заменить старые версии) ==========
function createEmptyOrderbook() {
  return { bids: new Map(), asks: new Map() };
}

// Нормализуем цену в строковый ключ с 2 знаками после запятой (USD)
function normalizePriceKey(price) {
  // price может быть number или строкой — всегда приводим к Number и затем toFixed(2)
  const n = Number(price);
  if (!isFinite(n)) return String(price);
  return n.toFixed(2);
}

// Возвращает массив уровней в виде { price: Number, size: Number }
// side: "buy" или "sell"
function orderbookToArray(ob, side, limit = 15) {
  const map = side === "buy" ? ob.bids : ob.asks;
  const arr = [...map.entries()].map(([priceK, size]) => {
    return { price: Number(priceK), size: Number(size) };
  });

  // buy — от большого к малому, sell — от малого к большому
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

// ========== LOAD SNAPSHOT (заменить старую функцию loadOrderBookSnapshot) ==========
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
    // Нормализуем ключи цен
    data.bids.slice(0, 2000).forEach(([p, s]) => ob.bids.set(normalizePriceKey(p), Number(s)));
    data.asks.slice(0, 2000).forEach(([p, s]) => ob.asks.set(normalizePriceKey(p), Number(s)));

    orderbookStore[product] = ob;
    // sequence устанавливаем только если есть число
    orderbookSeq[product] = typeof data.sequence === 'number' ? data.sequence : (orderbookSeq[product] || 0);
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

// ========== COINBASE WS MESSAGE HANDLER (заменить часть, отвечающую за l2update/snapshot) ==========
async function handleCoinbaseMessage(m) {
  const pair = m.product_id;
  if (!PRODUCTS.includes(pair)) return;

  if (m.type === "ticker") {
    latestPrice[pair] = Number(m.price);
    broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
    return;
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
    return;
  }

  // LEVEL2 UPDATE
  if (m.type === "l2update") {
    // Если нет стакана — грузим snapshot
    if (!orderbookStore[pair]) {
      console.log(`No orderbook for ${pair} — loading snapshot`);
      await loadOrderBookSnapshot(pair);
      return;
    }

    const ob = orderbookStore[pair];

    // Применяем изменения — НИКАК не записываем undefined в orderbookSeq
    if (Array.isArray(m.changes)) {
      m.changes.forEach(([side, price, size]) => {
        const pkey = normalizePriceKey(price);
        const s = Number(size);
        if (side === "buy") {
          if (s === 0) ob.bids.delete(pkey);
          else ob.bids.set(pkey, s);
        } else {
          if (s === 0) ob.asks.delete(pkey);
          else ob.asks.set(pkey, s);
        }
      });
    }

    // Не меняем orderbookSeq тут (Coinbase l2update может не иметь sequence).
    // Сбросим хэш, чтобы broadcast-таймер отправил обновление при следующей итерации:
    lastOBHash[pair] = "";
    return;
  }

  // WS SNAPSHOT (редко)
  if (m.type === "snapshot") {
    const ob = createEmptyOrderbook();
    if (Array.isArray(m.bids)) m.bids.forEach(([p, s]) => ob.bids.set(normalizePriceKey(p), Number(s)));
    if (Array.isArray(m.asks)) m.asks.forEach(([p, s]) => ob.asks.set(normalizePriceKey(p), Number(s)));
    orderbookStore[pair] = ob;
    orderbookSeq[pair] = typeof m.sequence === 'number' ? m.sequence : (orderbookSeq[pair] || -1);
    lastOBHash[pair] = "";
    console.log(`WS Snapshot received for ${pair}`);
    return;
  }
}

// =======================
// ORDERBOOK BROADCAST (каждые 200ms)
// =======================
setInterval(() => {
  PRODUCTS.forEach(pair => {
    const ob = orderbookStore[pair];
    if (!ob) return;

    const buy = orderbookToArray(ob, "buy", 50);
    const sell = orderbookToArray(ob, "sell", 50);

    const h = hashOB(buy, sell);
    if (h === lastOBHash[pair]) {
      // ничего не изменилось
      return;
    }
    lastOBHash[pair] = h;

    // Отправляем как числа (price:number, size:number)
    broadcast({ type: "orderBook", pair, buy, sell, ts: Date.now() });
    console.log(`📤 Sending orderBook update for ${pair}: ${buy.length} bids, ${sell.length} asks`);
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

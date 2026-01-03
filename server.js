import dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === НАСТРОЙКИ ===
const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.exchange.coinbase.com";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";

// ТВОИ ДАННЫЕ ПРОКСИ (Нидерланды)
const PROXY_URL = "http://aizhezhe01:LDtU5YgXwP@217.194.153.249:50100";
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const historyStore = {};
const orderbookStore = {};
const tradesStore = {}; 
const latestPrice = {};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
function getBinanceSymbol(product) {
  return product.replace("-", "").toLowerCase() + "t"; 
}

function getCoinbaseSymbol(binanceStreamName) {
  const symbol = binanceStreamName.split("@")[0];
  return symbol.toUpperCase().replace("USDT", "-USD");
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

// === 1. ЗАГРУЗКА ИСТОРИИ (COINBASE) ===
async function loadHistoryFor(product) {
  try {
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=60`;
    const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
    if (!r.ok) return;
    const chunk = await r.json();
    historyStore[product] = chunk.map(c => ({
      time: Math.floor(c[0]),
      open: Number(c[3]),
      high: Number(c[2]),
      low: Number(c[1]),
      close: Number(c[4]),
    })).sort((a, b) => a.time - b.time).slice(-1440);
    console.log(`✅ История ${product} загружена`);
  } catch (e) { console.error(`Ошибка истории ${product}:`, e.message); }
}

// === 2. ПОДКЛЮЧЕНИЕ К BINANCE ЧЕРЕЗ ПРОКСИ ===
let binanceWS;

function connectBinanceWS() {
  const streams = PRODUCTS.map(p => {
    const sym = getBinanceSymbol(p);
    return `${sym}@depth20@100ms/${sym}@aggTrade/${sym}@ticker`;
  }).join("/");

  console.log("🌐 Подключение к Binance Global через прокси (NL)...");
  
  // Передаем proxyAgent для обхода блокировки 451
  binanceWS = new WebSocket(BINANCE_WS_BASE + streams, { agent: proxyAgent });

  binanceWS.on("open", () => console.log("✅ Соединение с Binance через прокси установлено!"));

  binanceWS.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.data || !msg.stream) return;

      const pair = getCoinbaseSymbol(msg.stream);
      const streamName = msg.stream.split("@")[1];

      // 1. Стакан
      if (streamName.startsWith("depth")) {
        orderbookStore[pair] = formatBinanceOrderBook(msg.data.bids, msg.data.asks);
      } 
      // 2. Живая цена
      else if (streamName === "ticker") {
        latestPrice[pair] = Number(msg.data.c);
        broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
      }
      // 3. Последние сделки (Trades)
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
        broadcast({ type: "trades", pair, trades: [trade] });
      }
    } catch (e) { console.error("Parse error:", e); }
  });

  binanceWS.on("error", err => {
    console.error("❌ Ошибка сокета/прокси:", err.message);
  });

  binanceWS.on("close", () => {
    console.log("Binance WS закрыт. Реконнект через 5 сек...");
    setTimeout(connectBinanceWS, 5000);
  });
}

// Рассылка стакана (5 раз в секунду)
setInterval(() => {
  PRODUCTS.forEach(pair => {
    if (orderbookStore[pair]) {
      broadcast({ type: "orderBook", pair, ...orderbookStore[pair], ts: Date.now() });
    }
  });
}, 200);

// === 3. СЕРВЕР ДЛЯ КЛИЕНТОВ (FRONTEND) ===
wss.on("connection", ws => {
  ws.subscriptions = new Set();
  ws.on("message", raw => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
        ws.subscriptions.add(data.pair);
        
        // Отправляем начальные данные сразу после подписки
        if (historyStore[data.pair]) ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        if (latestPrice[data.pair]) ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        if (orderbookStore[data.pair]) ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, ...orderbookStore[data.pair] }));
        // Отправляем историю сделок, чтобы поле Last Trades не было пустым
        if (tradesStore[data.pair]) ws.send(JSON.stringify({ type: "trades", pair: data.pair, trades: tradesStore[data.pair].slice(-20) }));
      }
    } catch (e) { console.error(e); }
  });
});

async function init() {
  for (const p of PRODUCTS) await loadHistoryFor(p);
  connectBinanceWS();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
}

init();

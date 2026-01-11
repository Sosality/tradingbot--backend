import dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Pool } from "pg"; 
import cron from "node-cron";

const app = express();
app.use(cors());
app.use(express.json());

// === 🔥 HEALTH CHECK ROUTE 🔥 ===
app.get("/health", (req, res) => {
    res.status(200).send("Im Alive");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === НАСТРОЙКИ ===
const PRODUCTS = ["BTC-USD", "ETH-USD"];
// ⬇️ ИСПОЛЬЗУЕМ BINANCE API ВМЕСТО COINBASE ДЛЯ ИСТОРИИ
const BINANCE_REST = "https://api.binance.com/api/v3"; 
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
const PROXY_URL = "http://g4alts:nT6UVMhowL@45.153.162.250:59100";
const DATABASE_URL = process.env.DATABASE_URL; // Убедитесь, что переменная есть в .env
const BOT_TOKEN = process.env.BOT_TOKEN;

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const historyStore = {};
const orderbookStore = {};
const tradesStore = {}; 
const latestPrice = {};

// === ПОДКЛЮЧЕНИЕ К БД ===
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Иногда нужно для Render/Neon
});

db.connect().then(() => console.log("✅ Liquidation Engine Connected")).catch(e => console.error("DB Error:", e.message));

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
function getBinanceSymbol(product) {
  // BTC-USD -> btcusdt
  return product.replace("-", "").toLowerCase() + "t"; 
}

function getCoinbaseSymbol(binanceStreamName) {
  // btcusdt -> BTC-USD
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

// === TELEGRAM ALERT ===
async function sendTelegramAlert(userId, message) {
    if (!BOT_TOKEN || !userId) return;
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: userId, text: message, parse_mode: 'HTML' })
        });
    } catch (e) { console.error("TG Error:", e.message); }
}

let isProcessing = false;

// === 🔥 LIQUIDATION ENGINE 🔥 ===
async function checkLiquidations() {
    if (isProcessing || Object.keys(latestPrice).length === 0) return;
    isProcessing = true; 

    try {
        const res = await db.query(`SELECT * FROM positions`);
        if (res.rows.length === 0) { isProcessing = false; return; }

        for (const pos of res.rows) {
            const currentPrice = latestPrice[pos.pair];
            if (!currentPrice) continue;

            const entry = Number(pos.entry_price);
            const size = Number(pos.size); 
            const margin = Number(pos.margin);
            
            let pnl = 0;
            const diff = (currentPrice - entry) / entry;
            
            if (pos.type === "LONG") {
                pnl = diff * size;
            } else {
                pnl = -diff * size;
            }

            const closeCommission = size * 0.0003; 
            const maintenanceMargin = size * 0.004; 
            const remainingEquity = margin + pnl;
            const liquidationThreshold = closeCommission + maintenanceMargin;

            // === ЛИКВИДАЦИЯ ===
            if (remainingEquity <= liquidationThreshold) {
                console.log(`💀 LIQUIDATING: User ${pos.user_id} | ${pos.pair}`);
                await executeLiquidation(pos, currentPrice, size, -margin);
                continue; 
            }

            // === ПРЕДУПРЕЖДЕНИЕ ===
            const warningThreshold = liquidationThreshold * 1.2; 
            if (!pos.warning_sent && remainingEquity <= warningThreshold) {
                const msg = `⚠️ <b>MARGIN CALL</b> ⚠️\nPosition: ${pos.pair}\nEquity low!`;
                await sendTelegramAlert(pos.user_id, msg);
                await db.query(`UPDATE positions SET warning_sent = TRUE WHERE id = $1`, [pos.id]);
            }
        }
    } catch (e) {
        console.error("Liquidation Loop Error:", e.message);
    } finally {
        isProcessing = false; 
    }
}

async function executeLiquidation(pos, exitPrice, size, pnlValue) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        // ВНИМАНИЕ: Убедитесь, что таблица называется trades (как мы делали ранее) или trades_history
        // Я использую 'trades', так как мы создавали её в прошлом шаге. Если у вас 'trades_history', поправьте.
        await client.query(`
            INSERT INTO trades (user_id, pair, type, entry_price, close_price, size, leverage, pnl)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [pos.user_id, pos.pair, pos.type, pos.entry_price, exitPrice, size, pos.leverage, pnlValue]);

        await client.query(`DELETE FROM positions WHERE id = $1`, [pos.id]);
        await client.query("COMMIT");
        
        const msg = `⛔️ <b>LIQUIDATED</b>\n${pos.pair} closed.\nLoss: ${pnlValue.toFixed(2)} VP`;
        sendTelegramAlert(pos.user_id, msg);
    } catch (e) {
        await client.query("ROLLBACK");
        console.error("Liquidation DB Error:", e);
    } finally {
        client.release();
    }
}

setInterval(checkLiquidations, 1000);

// === 1. ЗАГРУЗКА ИСТОРИИ (BINANCE) ===
// Исправлено: теперь берем историю с Binance, чтобы совпадала с WebSockets
async function loadHistoryFor(product) {
  try {
    const symbol = getBinanceSymbol(product).toUpperCase(); // BTCUSDT
    // Запрашиваем 1000 свечей по 1 минуте
    const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=1m&limit=1000`;
    
    // Binance API обычно не требует прокси для публичных данных, но если блокирует - добавьте agent
    const r = await fetch(url);
    if (!r.ok) return;
    
    const data = await r.json();
    
    // Binance Format: [ [time, open, high, low, close, vol, ...], ... ]
    historyStore[product] = data.map(c => ({
      time: Math.floor(c[0] / 1000), // Binance дает мс, нам нужны секунды для LightweightCharts
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
    }));
    
    // console.log(`✅ История ${product} обновлена (Binance)`);
  } catch (e) { console.error(`Ошибка истории ${product}:`, e.message); }
}

// === 2. ПОДКЛЮЧЕНИЕ К BINANCE WS ===
let binanceWS;
function connectBinanceWS() {
  const streams = PRODUCTS.map(p => {
    const sym = getBinanceSymbol(p);
    return `${sym}@depth20@100ms/${sym}@aggTrade/${sym}@ticker`;
  }).join("/");

  console.log("🌐 Подключение к Binance WS...");
  binanceWS = new WebSocket(BINANCE_WS_BASE + streams, { agent: proxyAgent });

  binanceWS.on("open", () => console.log("✅ WS Open"));
  binanceWS.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.data || !msg.stream) return;

      const pair = getCoinbaseSymbol(msg.stream);
      const streamName = msg.stream.split("@")[1];

      if (streamName.startsWith("depth")) {
        orderbookStore[pair] = formatBinanceOrderBook(msg.data.bids, msg.data.asks);
      } 
      else if (streamName === "ticker") {
        latestPrice[pair] = Number(msg.data.c);
        broadcast({ type: "price", pair, price: latestPrice[pair], ts: Date.now() });
      }
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
    } catch (e) { }
  });

  binanceWS.on("close", () => setTimeout(connectBinanceWS, 5000));
  binanceWS.on("error", (e) => console.error("WS Error", e.message));
}

setInterval(() => {
  PRODUCTS.forEach(pair => {
    if (orderbookStore[pair]) broadcast({ type: "orderBook", pair, ...orderbookStore[pair] });
  });
}, 200);

// === 3. СЕРВЕР ДЛЯ КЛИЕНТОВ ===
wss.on("connection", ws => {
  ws.subscriptions = new Set();
  ws.on("message", raw => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
        ws.subscriptions.add(data.pair);
        if (historyStore[data.pair]) ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        if (latestPrice[data.pair]) ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair] }));
      }
    } catch (e) { }
  });
});

// Anti-Sleep
const MAIN_SERVER_URL = "https://tradingbot-p9n8.onrender.com"; 
cron.schedule("*/10 * * * *", async () => {
    try { await fetch(`${MAIN_SERVER_URL}/api/health`); } catch (e) { }
});

// History Update
cron.schedule("*/1 * * * *", async () => {
    for (const p of PRODUCTS) await loadHistoryFor(p);
});

async function init() {
  for (const p of PRODUCTS) await loadHistoryFor(p);
  connectBinanceWS();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🚀 PriceServer running on port ${PORT}`));
}

init();

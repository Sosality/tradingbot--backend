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
const COINBASE_REST = "https://api.exchange.coinbase.com";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
const PROXY_URL = "http://g4alts:nT6UVMhowL@45.153.162.250:59100";
const DATABASE_URL = "postgresql://neondb_owner:npg_igxGcyUQmX52@ep-ancient-sky-a9db2z9z-pooler.gwc.azure.neon.tech/neondb?sslmode=require&channel_binding=require";
const BOT_TOKEN = process.env.BOT_TOKEN;

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const historyStore = {};
const orderbookStore = {};
const tradesStore = {}; 
const latestPrice = {};

// === ПОДКЛЮЧЕНИЕ К БД ===
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: true
});

db.connect().then(() => console.log("✅ Liquidation Engine Connected")).catch(e => console.error("DB Error:", e.message));

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
    } catch (e) {
        console.error("❌ TG ERROR:", e.message);
    }
}

let isProcessing = false;

// === 🔥 LIQUIDATION ENGINE 🔥 ===
async function checkLiquidations() {
    if (isProcessing || Object.keys(latestPrice).length === 0) return;
    isProcessing = true; 

    try {
        const res = await db.query(`SELECT * FROM positions`);
        if (res.rows.length === 0) {
            isProcessing = false;
            return;
        }

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
                const msg = `⚠️ <b>MARGIN CALL WARNING</b> ⚠️\n\n` +
                            `Your position <b>${pos.type} ${pos.pair}</b> (x${pos.leverage}) is at risk!\n` +
                            `💰 Equity: ${remainingEquity.toFixed(2)} VP\n` +
                            `System will auto-liquidate shortly.`;

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
        await client.query(`
            INSERT INTO trades_history (user_id, pair, type, entry_price, exit_price, size, leverage, pnl, commission)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [pos.user_id, pos.pair, pos.type, pos.entry_price, exitPrice, size, pos.leverage, pnlValue, 0]);

        await client.query(`DELETE FROM positions WHERE id = $1`, [pos.id]);
        await client.query("COMMIT");
        
        const msg = `⛔️ <b>LIQUIDATED</b>\n\nPos: <b>${pos.pair}</b>\nLoss: ${pnlValue.toFixed(2)} VP`;
        sendTelegramAlert(pos.user_id, msg);

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("Liquidation DB Error:", e);
    } finally {
        client.release();
    }
}

setInterval(checkLiquidations, 500);

// === 1. ЗАГРУЗКА ИСТОРИИ (СИНХРОНИЗИРОВАННАЯ) ===
async function loadHistoryFor(product) {
  try {
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=60`;
    const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
    if (!r.ok) return;
    
    const chunk = await r.json();
    let candles = chunk.map(c => ({
      time: Math.floor(c[0]),
      open: Number(c[3]),
      high: Number(c[2]),
      low: Number(c[1]),
      close: Number(c[4]),
    })).sort((a, b) => a.time - b.time).slice(-1440);

    // 🔥 ФИКС БОЛЬШОЙ СВЕЧИ 🔥
    // Если у нас уже есть цена от Binance, мы подгоняем историю Coinbase под неё.
    if (latestPrice[product] && candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const binancePrice = latestPrice[product];
        const difference = binancePrice - lastCandle.close; // Разница между биржами

        // Смещаем ВСЕ свечи на эту разницу, чтобы график был бесшовным
        candles = candles.map(c => ({
            time: c.time,
            open: c.open + difference,
            high: c.high + difference,
            low: c.low + difference,
            close: c.close + difference
        }));
        // console.log(`🔧 Synced ${product}: Shifted by ${difference.toFixed(2)}`);
    }

    historyStore[product] = candles;

  } catch (e) { console.error(`Ошибка истории ${product}:`, e.message); }
}

// === 2. ПОДКЛЮЧЕНИЕ К BINANCE ===
let binanceWS;

function connectBinanceWS() {
  const streams = PRODUCTS.map(p => {
    const sym = getBinanceSymbol(p);
    return `${sym}@depth20@100ms/${sym}@aggTrade/${sym}@ticker`;
  }).join("/");

  console.log("🌐 Подключение к Binance Global через прокси (NL)...");
    
  binanceWS = new WebSocket(BINANCE_WS_BASE + streams, { agent: proxyAgent });

  binanceWS.on("open", () => console.log("✅ Соединение с Binance установлено!"));

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
    } catch (e) { console.error("Parse error:", e); }
  });

  binanceWS.on("error", err => {
    console.error("❌ WS Error:", err.message);
  });

  binanceWS.on("close", () => {
    console.log("Reconnecting Binance...");
    setTimeout(connectBinanceWS, 5000);
  });
}

setInterval(() => {
  PRODUCTS.forEach(pair => {
    if (orderbookStore[pair]) {
      broadcast({ type: "orderBook", pair, ...orderbookStore[pair], ts: Date.now() });
    }
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
        // При подписке мы отправляем уже "сдвинутую" историю, совпадающую с ценой Binance
        if (historyStore[data.pair]) ws.send(JSON.stringify({ type: "history", pair: data.pair, data: historyStore[data.pair] }));
        if (latestPrice[data.pair]) ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
        if (orderbookStore[data.pair]) ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, ...orderbookStore[data.pair] }));
        if (tradesStore[data.pair]) ws.send(JSON.stringify({ type: "trades", pair: data.pair, trades: tradesStore[data.pair].slice(-20) }));
      }
    } catch (e) { console.error(e); }
  });
});

const MAIN_SERVER_URL = "https://tradingbot-p9n8.onrender.com"; 

cron.schedule("*/10 * * * *", async () => {
    try { await fetch(`${MAIN_SERVER_URL}/api/health`); } catch (e) { }
});

// Обновляем историю чаще и синхронизируем её
cron.schedule("*/1 * * * *", async () => {
    for (const p of PRODUCTS) await loadHistoryFor(p);
});

async function init() {
  connectBinanceWS();
  // Ждем 2 секунды, чтобы получить цену Binance ПЕРЕД загрузкой истории для синхронизации
  setTimeout(async () => {
      for (const p of PRODUCTS) await loadHistoryFor(p);
  }, 2000);
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🚀 PriceServer running on port ${PORT}`));
}

init();

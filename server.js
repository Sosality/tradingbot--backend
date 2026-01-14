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
const TIMEFRAMES = [60, 300, 900, 3600, 21600, 86400]; // 1m, 5m, 15m, 1h, 6h, 1d

// === CANDLES/HISTORY SETTINGS ===
// Coinbase candle endpoint returns up to 300 candles per request.
const COINBASE_MAX_CANDLES_PER_REQUEST = 300;
// Client mentioned it initially loads ~1400 candles.
const INITIAL_HISTORY_CANDLES = 1400;
// Memory cap per (pair,timeframe)
const MAX_CACHED_CANDLES = 20000;

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const historyStore = {};
const orderbookStore = {};
const tradesStore = {};
const latestPrice = {};

// Prevent multiple simultaneous Coinbase backfills for the same (pair,timeframe)
const historyLocks = new Map();

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

function normalizeGranularity(granularity) {
    const g = Number(granularity);
    return TIMEFRAMES.includes(g) ? g : 60;
}

function ensureHistoryBucket(product, granularity) {
    if (!historyStore[product]) historyStore[product] = {};
    if (!historyStore[product][granularity]) historyStore[product][granularity] = [];
    return historyStore[product][granularity];
}

function mergeCandles(existing, incoming) {
    if (!incoming || incoming.length === 0) return existing;

    const map = new Map();
    for (const c of existing) map.set(c.time, c);
    for (const c of incoming) map.set(c.time, c); // incoming overwrites

    const merged = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (merged.length > MAX_CACHED_CANDLES) {
        // Keep the most recent MAX_CACHED_CANDLES (prevents unbounded memory usage)
        return merged.slice(-MAX_CACHED_CANDLES);
    }
    return merged;
}

function withHistoryLock(product, granularity, fn) {
    const key = `${product}:${granularity}`;
    const prev = historyLocks.get(key) || Promise.resolve();

    // Chain tasks sequentially
    const next = prev
        .catch(() => {})
        .then(fn)
        .finally(() => {
            if (historyLocks.get(key) === next) historyLocks.delete(key);
        });

    historyLocks.set(key, next);
    return next;
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
    if (!BOT_TOKEN || !userId) {
        console.error("⚠️ TG Alert skipped: No Token or User ID");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: userId,
                text: message,
                parse_mode: 'HTML'
            })
        });

        const data = await response.json();

        if (!data.ok) {
            console.error(`❌ TELEGRAM API ERROR for User ${userId}: ${data.description}`);
        } else {
            console.log(`✅ Message sent to ${userId}`);
        }
    } catch (e) {
        console.error("❌ NETWORK/FETCH ERROR:", e.message);
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
                await executeLiquidation(pos, currentPrice);
                continue;
            }

            // === ПРЕДУПРЕЖДЕНИЕ ===
            const warningThreshold = liquidationThreshold * 1.2;

            if (!pos.warning_sent && remainingEquity <= warningThreshold) {
                const pnlFormatted = pnl.toFixed(2);

                const msg = `⚠️ <b>MARGIN CALL WARNING</b> ⚠️\n\n` +
                    `Your position <b>${pos.type} ${pos.pair}</b> (x${pos.leverage}) is at risk!\n\n` +
                    `📉 PnL: ${pnlFormatted} VP\n` +
                    `💰 Remaining Equity: ${remainingEquity.toFixed(2)} VP\n` +
                    `💀 Liquidation at approx: ${liquidationThreshold.toFixed(2)} VP\n\n` +
                    `System will auto-liquidate if equity drops further.`;

                await sendTelegramAlert(pos.user_id, msg);
                await db.query(`UPDATE positions SET warning_sent = TRUE WHERE id = $1`, [pos.id]);
                console.log(`⚠️ Warning sent to user ${pos.user_id}`);
            }
        }
    } catch (e) {
        console.error("Liquidation Loop Error:", e.message);
    } finally {
        isProcessing = false;
    }
}

async function executeLiquidation(pos, exitPrice) {
    const client = await db.connect();
    try {
        const size = Number(pos.size);
        const margin = Number(pos.margin);

        // Комиссия закрытия (0.03% от notional/size)
        const closeCommission = size * 0.0003;

        // Мы моделируем liquidation как: вся маржа сгорает (на баланс ничего не возвращаем).
        // Чтобы история была консистентной с totalReturn=0:
        // totalReturn = margin + pnl - commission = 0 => pnl = commission - margin
        // pnl здесь — "gross" (без комиссии), а commission — отдельным полем.
        const pnlGross = closeCommission - margin;

        await client.query("BEGIN");
        await client.query(`
            INSERT INTO trades_history (user_id, pair, type, entry_price, exit_price, size, leverage, pnl, commission)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [pos.user_id, pos.pair, pos.type, pos.entry_price, exitPrice, size, pos.leverage, pnlGross, closeCommission]);

        await client.query(`DELETE FROM positions WHERE id = $1`, [pos.id]);
        await client.query("COMMIT");

        const msg = `⛔️ <b>LIQUIDATED</b>\n\n` +
            `Your position <b>${pos.pair}</b> has been forcefully closed.\n` +
            `📉 Loss: ${(-margin).toFixed(2)} VP\n` +
            `💸 Fee: ${closeCommission.toFixed(2)} VP\n` +
            `Price reached liquidation level.`;

        sendTelegramAlert(pos.user_id, msg);

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("Liquidation DB Error:", e);
    } finally {
        client.release();
    }
}

setInterval(checkLiquidations, 500);

// === 1. ЗАГРУЗКА ИСТОРИИ (COINBASE) ===
async function fetchCoinbaseCandlesPage(product, granularity, endSec) {
    try {
        const end = new Date(endSec * 1000);
        const start = new Date((endSec - (granularity * COINBASE_MAX_CANDLES_PER_REQUEST)) * 1000);

        const url = `${COINBASE_REST}/products/${product}/candles` +
            `?granularity=${granularity}` +
            `&start=${encodeURIComponent(start.toISOString())}` +
            `&end=${encodeURIComponent(end.toISOString())}`;

        const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
        if (!r.ok) return;
        const chunk = await r.json();

        // Coinbase returns [ time, low, high, open, close, volume ]
        return chunk
            .map(c => ({
                time: Math.floor(c[0]),
                open: Number(c[3]),
                high: Number(c[2]),
                low: Number(c[1]),
                close: Number(c[4]),
            }))
            .sort((a, b) => a.time - b.time);
    } catch (e) {
        console.error(`Ошибка истории ${product} (${granularity}s):`, e.message);
        return;
    }
}

async function refreshLatestHistory(product, granularity = 60) {
    const g = normalizeGranularity(granularity);
    const nowSec = Math.floor(Date.now() / 1000);
    const page = await fetchCoinbaseCandlesPage(product, g, nowSec);
    if (!page || page.length === 0) return;

    const existing = ensureHistoryBucket(product, g);
    historyStore[product][g] = mergeCandles(existing, page);
}

async function ensureHistoryLength(product, granularity = 60, minCandles = INITIAL_HISTORY_CANDLES) {
    const g = normalizeGranularity(granularity);

    await refreshLatestHistory(product, g);
    ensureHistoryBucket(product, g);

    let arr = historyStore[product][g];
    // Backfill older candles until we have enough for initial load
    // Coinbase is paginated by time ranges; each call gives up to 300 candles.
    let safetyPages = 0;
    while (arr.length < minCandles && safetyPages < 20 && arr.length > 0) {
        safetyPages++;
        const oldest = arr[0].time;
        const endSec = oldest - 1;
        const page = await fetchCoinbaseCandlesPage(product, g, endSec);
        if (!page || page.length === 0) break;
        arr = mergeCandles(arr, page);
        historyStore[product][g] = arr;

        // If we didn't extend the left edge, stop (prevents infinite loop on API quirks)
        if (arr[0].time >= oldest) break;
    }
}

async function ensureHistoryBefore(product, granularity, untilSec) {
    const g = normalizeGranularity(granularity);
    ensureHistoryBucket(product, g);

    let arr = historyStore[product][g];
    if (arr.length === 0) {
        await ensureHistoryLength(product, g, INITIAL_HISTORY_CANDLES);
        arr = historyStore[product][g];
        if (arr.length === 0) return;
    }

    // If the client requests older than our current oldest, backfill more pages.
    let safetyPages = 0;
    while (arr.length > 0 && arr[0].time >= untilSec && safetyPages < 20) {
        safetyPages++;
        const oldest = arr[0].time;
        const endSec = oldest - 1;
        const page = await fetchCoinbaseCandlesPage(product, g, endSec);
        if (!page || page.length === 0) break;
        arr = mergeCandles(arr, page);
        historyStore[product][g] = arr;

        if (arr[0].time >= oldest) break;
    }
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

    ws.on("message", async raw => {
        try {
            const data = JSON.parse(raw.toString());

            // SUBSCRIBE / CHANGE TIMEFRAME
            if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
                ws.subscriptions.add(data.pair);
                const granularity = normalizeGranularity(data.timeframe || 60); // Default 1m

                // Send History
                await withHistoryLock(data.pair, granularity, async () => {
                    // Ensure we have enough candles for initial display
                    await ensureHistoryLength(data.pair, granularity, INITIAL_HISTORY_CANDLES);
                });

                const fullHistory = (historyStore[data.pair] && historyStore[data.pair][granularity])
                    ? historyStore[data.pair][granularity]
                    : [];

                const initialData = fullHistory.slice(-INITIAL_HISTORY_CANDLES);
                ws.send(JSON.stringify({
                    type: "history",
                    pair: data.pair,
                    data: initialData,
                    timeframe: granularity
                }));

                if (latestPrice[data.pair]) ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
                if (orderbookStore[data.pair]) ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, ...orderbookStore[data.pair] }));
                if (tradesStore[data.pair]) ws.send(JSON.stringify({ type: "trades", pair: data.pair, trades: tradesStore[data.pair].slice(-20) }));
            }

            // LOAD MORE HISTORY (LAZY LOADING)
            if (data.type === "loadMore" && PRODUCTS.includes(data.pair)) {
                const granularity = normalizeGranularity(data.timeframe || 60);
                const oldestTime = data.until; // Timestamp of the leftmost visible candle

                console.log(`📥 loadMore request: ${data.pair} @ ${granularity}s, before ${new Date(oldestTime * 1000).toISOString()}`);

                await withHistoryLock(data.pair, granularity, async () => {
                    await ensureHistoryBefore(data.pair, granularity, oldestTime);
                });

                const fullHistory = (historyStore[data.pair] && historyStore[data.pair][granularity])
                    ? historyStore[data.pair][granularity]
                    : [];

                const olderCandles = fullHistory.filter(c => c.time < oldestTime);
                const chunk = olderCandles.slice(-COINBASE_MAX_CANDLES_PER_REQUEST);

                console.log(`📤 Found ${chunk.length} older candles to send back`);

                // ALWAYS send response (even if empty) so client knows to stop waiting
                ws.send(JSON.stringify({
                    type: "moreHistory",
                    pair: data.pair,
                    data: chunk,
                    timeframe: granularity
                }));
            }

        } catch (e) { console.error(e); }
    });
});

// === 🛡️ СИСТЕМА ANTI-SLEEP ===
const MAIN_SERVER_URL = "https://tradingbot-p9n8.onrender.com";

// 1. Пингуем другой сервер
cron.schedule("*/10 * * * *", async () => {
    // console.log("⏰ Anti-Sleep: Pinging Main Server...");
    try {
        await fetch(`${MAIN_SERVER_URL}/api/health`);
    } catch (e) { }
});

// === 🔄 АВТО-ОБНОВЛЕНИЕ ИСТОРИИ (НОВОЕ!) ===
// Обновляем массив истории свечей каждую минуту
cron.schedule("*/1 * * * *", async () => {
    // console.log("🔄 Updating Candle History...");
    for (const p of PRODUCTS) {
        for (const tf of TIMEFRAMES) {
            // Refresh only the latest page, while keeping already backfilled older candles
            await withHistoryLock(p, tf, async () => {
                await refreshLatestHistory(p, tf);
            });
        }
    }
});

async function init() {
    for (const p of PRODUCTS) {
        for (const tf of TIMEFRAMES) {
            await withHistoryLock(p, tf, async () => {
                await ensureHistoryLength(p, tf, INITIAL_HISTORY_CANDLES);
            });
        }
    }
    connectBinanceWS();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🚀 PriceServer running on port ${PORT}`));
}

init();

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

app.get("/health", (req, res) => {
    res.status(200).send("Im Alive");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.exchange.coinbase.com";
const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
const PROXY_URL = "http://g4alts:nT6UVMhowL@45.153.162.250:59100";
const DATABASE_URL = "postgresql://neondb_owner:npg_igxGcyUQmX52@ep-ancient-sky-a9db2z9z-pooler.gwc.azure.neon.tech/neondb?sslmode=require&channel_binding=require";
const BOT_TOKEN = process.env.BOT_TOKEN;
const TIMEFRAMES = [60, 300, 900, 3600, 21600, 86400];

const COINBASE_MAX_CANDLES_PER_REQUEST = 300;
const INITIAL_HISTORY_CANDLES = 1400;
const MAX_CACHED_CANDLES = 20000;

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const historyStore = {};
const orderbookStore = {};
const tradesStore = {};
const latestPrice = {};

const historyLocks = new Map();

const db = new Pool({
    connectionString: DATABASE_URL,
    ssl: true
});

db.connect().then(() => console.log("✅ Liquidation & TP/SL Engine Connected")).catch(e => console.error("DB Error:", e.message));

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
    for (const c of incoming) map.set(c.time, c);
    const merged = Array.from(map.values()).sort((a, b) => a.time - b.time);
    if (merged.length > MAX_CACHED_CANDLES) {
        return merged.slice(-MAX_CACHED_CANDLES);
    }
    return merged;
}

function withHistoryLock(product, granularity, fn) {
    const key = `${product}:${granularity}`;
    const prev = historyLocks.get(key) || Promise.resolve();
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

let isProcessingLiquidations = false;
let isProcessingTPSL = false;

// ======================== LIQUIDATION ENGINE ========================

async function checkLiquidations() {
    if (isProcessingLiquidations || Object.keys(latestPrice).length === 0) return;
    isProcessingLiquidations = true;

    try {
        const res = await db.query(`SELECT * FROM positions`);
        if (res.rows.length === 0) { isProcessingLiquidations = false; return; }

        for (const pos of res.rows) {
            const currentPrice = latestPrice[pos.pair];
            if (!currentPrice) continue;

            const entry = Number(pos.entry_price);
            const size = Number(pos.size);
            const margin = Number(pos.margin);

            let pnl = 0;
            const diff = (currentPrice - entry) / entry;
            if (pos.type === "LONG") { pnl = diff * size; }
            else { pnl = -diff * size; }

            const closeCommission = size * 0.0003;
            const maintenanceMargin = size * 0.004;
            const remainingEquity = margin + pnl;
            const liquidationThreshold = closeCommission + maintenanceMargin;

            if (remainingEquity <= liquidationThreshold) {
                console.log(`💀 LIQUIDATING: User ${pos.user_id} | ${pos.pair}`);
                await executeLiquidation(pos, currentPrice);
                continue;
            }

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
        isProcessingLiquidations = false;
    }
}

async function executeLiquidation(pos, exitPrice) {
    const client = await db.connect();
    try {
        const size = Number(pos.size);
        const margin = Number(pos.margin);
        const closeCommission = size * 0.0003;
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

// ======================== TP/SL ENGINE ========================

async function checkTPSL() {
    if (isProcessingTPSL || Object.keys(latestPrice).length === 0) return;
    isProcessingTPSL = true;

    try {
        const activeOrders = await db.query(
            "SELECT * FROM tp_sl_orders WHERE status = 'ACTIVE' ORDER BY created_at ASC"
        );

        if (activeOrders.rows.length === 0) { isProcessingTPSL = false; return; }

        const positionCache = new Map();

        for (const order of activeOrders.rows) {
            const currentPrice = latestPrice[order.pair];
            if (!currentPrice) continue;

            let pos = positionCache.get(Number(order.position_id));
            if (!pos) {
                const posRes = await db.query("SELECT * FROM positions WHERE id = $1", [order.position_id]);
                if (!posRes.rows.length) {
                    await db.query("UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE id = $1", [order.id]);
                    console.log(`🗑️ TP/SL ${order.id} cancelled - position ${order.position_id} no longer exists`);
                    continue;
                }
                pos = posRes.rows[0];
                positionCache.set(Number(order.position_id), pos);
            }

            const posType = pos.type.toUpperCase();
            const triggerPrice = Number(order.trigger_price);
            let triggered = false;

            if (order.order_type === 'TP') {
                if (posType === 'LONG' && currentPrice >= triggerPrice) triggered = true;
                if (posType === 'SHORT' && currentPrice <= triggerPrice) triggered = true;
            } else if (order.order_type === 'SL') {
                if (posType === 'LONG' && currentPrice <= triggerPrice) triggered = true;
                if (posType === 'SHORT' && currentPrice >= triggerPrice) triggered = true;
            }

            if (triggered) {
                console.log(`🎯 ${order.order_type} TRIGGERED for position ${order.position_id} at price ${currentPrice} (target: ${triggerPrice})`);
                await executeTPSL(order, pos, currentPrice);
                positionCache.delete(Number(order.position_id));
            }
        }
    } catch (e) {
        console.error("TP/SL Check Error:", e.message);
    } finally {
        isProcessingTPSL = false;
    }
}

async function executeTPSL(order, pos, exitPrice) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const freshPos = await client.query("SELECT * FROM positions WHERE id = $1 FOR UPDATE", [order.position_id]);
        if (!freshPos.rows.length) {
            await client.query("UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE id = $1", [order.id]);
            await client.query("COMMIT");
            return;
        }

        const position = freshPos.rows[0];
        const totalSize = Number(position.size);
        const totalMargin = Number(position.margin);
        const entryPrice = Number(position.entry_price);
        const leverage = Number(position.leverage);
        const sizePercent = Number(order.size_percent);
        const isFullClose = sizePercent >= 100;

        let closeSize;
        if (isFullClose) {
            closeSize = totalSize;
        } else {
            closeSize = Math.min((totalSize * sizePercent) / 100, totalSize);
        }

        const closeMargin = (closeSize / totalSize) * totalMargin;
        const priceChangePct = (exitPrice - entryPrice) / entryPrice;
        let pnl = priceChangePct * closeSize;
        if (position.type === "SHORT") pnl = -pnl;

        const commission = closeSize * 0.0003;
        let totalReturn = closeMargin + pnl - commission;

        if (totalReturn < 0) totalReturn = 0;

        if (totalReturn > 0) {
            await client.query("UPDATE users SET balance = balance + $1 WHERE user_id = $2", [totalReturn, position.user_id]);
        }

        await client.query(`
            INSERT INTO trades_history (user_id, pair, type, entry_price, exit_price, size, leverage, pnl, commission)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [position.user_id, position.pair, position.type, entryPrice, exitPrice, closeSize, leverage, pnl, commission]);

        await client.query(
            "UPDATE tp_sl_orders SET status = 'TRIGGERED', triggered_at = CURRENT_TIMESTAMP WHERE id = $1",
            [order.id]
        );

        const remainingSize = totalSize - closeSize;

        if (isFullClose || remainingSize <= 0.01) {
            await client.query("DELETE FROM positions WHERE id = $1", [order.position_id]);
            console.log(`✅ Position ${order.position_id} fully closed by ${order.order_type}`);
        } else {
            const remainingMargin = totalMargin - closeMargin;
            await client.query(
                "UPDATE positions SET size = $1, margin = $2 WHERE id = $3",
                [remainingSize, remainingMargin, order.position_id]
            );

            const remainingOrders = await client.query(
                "SELECT * FROM tp_sl_orders WHERE position_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC",
                [order.position_id]
            );

            for (const ro of remainingOrders.rows) {
                const newSizeAmount = (remainingSize * Number(ro.size_percent)) / 100;
                await client.query(
                    "UPDATE tp_sl_orders SET size_amount = $1 WHERE id = $2",
                    [newSizeAmount, ro.id]
                );
            }

            console.log(`✅ Partial ${order.order_type} executed for position ${order.position_id}: closed ${closeSize.toFixed(4)}, remaining ${remainingSize.toFixed(4)}`);
        }

        await client.query("COMMIT");

        const typeLabel = order.order_type === 'TP' ? 'Take Profit' : 'Stop Loss';
        const pnlSign = pnl >= 0 ? '+' : '';
        const emoji = order.order_type === 'TP' ? '🎯' : '🛑';
        const partialLabel = isFullClose ? '' : ` (${sizePercent}%)`;

        const msg = `${emoji} <b>${typeLabel} Triggered</b>${partialLabel}\n\n` +
            `Pair: <b>${position.pair}</b> ${position.type} x${leverage}\n` +
            `Trigger Price: ${exitPrice}\n` +
            `Size Closed: ${closeSize.toFixed(2)}\n` +
            `${pnlSign}${pnl.toFixed(2)} VP (Fee: ${commission.toFixed(2)} VP)\n` +
            (isFullClose ? `\nPosition fully closed.` : `\nRemaining size: ${remainingSize.toFixed(2)}`);

        sendTelegramAlert(position.user_id, msg);

    } catch (e) {
        await client.query("ROLLBACK");
        console.error(`❌ TP/SL Execution Error for order ${order.id}:`, e.message);
    } finally {
        client.release();
    }
}

setInterval(checkLiquidations, 500);
setInterval(checkTPSL, 500);

// ======================== CANDLE HISTORY ========================

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
    let safetyPages = 0;
    while (arr.length < minCandles && safetyPages < 20 && arr.length > 0) {
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

async function ensureHistoryBefore(product, granularity, untilSec) {
    const g = normalizeGranularity(granularity);
    ensureHistoryBucket(product, g);

    let arr = historyStore[product][g];
    if (arr.length === 0) {
        await ensureHistoryLength(product, g, INITIAL_HISTORY_CANDLES);
        arr = historyStore[product][g];
        if (arr.length === 0) return;
    }

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

// ======================== BINANCE WEBSOCKET ========================

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

// ======================== CLIENT WEBSOCKET ========================

wss.on("connection", ws => {
    ws.subscriptions = new Set();

    ws.on("message", async raw => {
        try {
            const data = JSON.parse(raw.toString());

            if (data.type === "subscribe" && PRODUCTS.includes(data.pair)) {
                ws.subscriptions.add(data.pair);
                const granularity = normalizeGranularity(data.timeframe || 60);

                await withHistoryLock(data.pair, granularity, async () => {
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

            if (data.type === "loadMore" && PRODUCTS.includes(data.pair)) {
                const granularity = normalizeGranularity(data.timeframe || 60);
                const oldestTime = data.until;

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

// ======================== ANTI-SLEEP & CRON ========================

const MAIN_SERVER_URL = "https://tradingbot-p9n8.onrender.com";

cron.schedule("*/10 * * * *", async () => {
    try {
        await fetch(`${MAIN_SERVER_URL}/api/health`);
    } catch (e) { }
});

cron.schedule("*/1 * * * *", async () => {
    for (const p of PRODUCTS) {
        for (const tf of TIMEFRAMES) {
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

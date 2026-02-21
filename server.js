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
const PROXY_URL = "http://s4ckyrylor:HkuQGepJBd@185.13.225.203:59100";
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TIMEFRAMES = [60, 300, 900, 3600, 21600, 86400];

const COINBASE_MAX_CANDLES_PER_REQUEST = 300;
const INITIAL_HISTORY_CANDLES = 1400;
const MAX_CACHED_CANDLES = 20000;

const MIN_PARTIAL_PERCENT = 10;
const MAX_TP_PER_POSITION = 3;
const MAX_SL_PER_POSITION = 3;

const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const historyStore = {};
const orderbookStore = {};
const tradesStore = {};
const latestPrice = {};

const historyLocks = new Map();

const userWebSockets = new Map();

const db = new Pool({
    connectionString: DATABASE_URL,
    ssl: true
});

async function initDatabase() {
    try {
        await db.connect();
        console.log("✅ Database Connected");

        await db.query(`
            CREATE TABLE IF NOT EXISTS tp_sl_orders (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                position_id INTEGER NOT NULL,
                pair VARCHAR(20) NOT NULL,
                order_type VARCHAR(10) NOT NULL CHECK (order_type IN ('TP', 'SL')),
                trigger_price DECIMAL(20, 8) NOT NULL,
                size_percent DECIMAL(5, 2) NOT NULL DEFAULT 100,
                status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'CANCELLED')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                triggered_at TIMESTAMP
            )
        `);

        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_tpsl_position ON tp_sl_orders(position_id)
        `);
        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_tpsl_status ON tp_sl_orders(status)
        `);
        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_tpsl_user ON tp_sl_orders(user_id)
        `);

        console.log("✅ TP/SL Orders table ready");
    } catch (e) {
        console.error("DB Init Error:", e.message);
    }
}

initDatabase();

function registerUserWebSocket(userId, ws) {
    if (!userId) return;
    const id = String(userId);
    if (!userWebSockets.has(id)) {
        userWebSockets.set(id, new Set());
    }
    userWebSockets.get(id).add(ws);
    ws.userId = id;
    console.log(`📱 User ${id} connected via WebSocket`);
}

function unregisterUserWebSocket(ws) {
    if (ws.userId && userWebSockets.has(ws.userId)) {
        userWebSockets.get(ws.userId).delete(ws);
        if (userWebSockets.get(ws.userId).size === 0) {
            userWebSockets.delete(ws.userId);
        }
        console.log(`📴 User ${ws.userId} disconnected from WebSocket`);
    }
}

function sendToUser(userId, message) {
    const id = String(userId);
    const sockets = userWebSockets.get(id);
    if (!sockets || sockets.size === 0) return;
    
    const text = JSON.stringify(message);
    for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(text);
        }
    }
}

async function fetchUserPositionsAndOrders(userId) {
    const positionsRes = await db.query(
        "SELECT * FROM positions WHERE user_id = $1",
        [userId]
    );
    
    const ordersRes = await db.query(
        "SELECT * FROM tp_sl_orders WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC",
        [userId]
    );
    
    const balanceRes = await db.query(
        "SELECT balance FROM users WHERE user_id = $1",
        [userId]
    );
    
    return {
        positions: positionsRes.rows,
        tpSlOrders: ordersRes.rows,
        balance: balanceRes.rows[0]?.balance || 0
    };
}

async function notifyUserPositionUpdate(userId, eventType, details = {}) {
    try {
        const data = await fetchUserPositionsAndOrders(userId);
        
        sendToUser(userId, {
            type: "positionUpdate",
            eventType: eventType,
            positions: data.positions,
            tpSlOrders: data.tpSlOrders,
            balance: Number(data.balance),
            details: details,
            timestamp: Date.now()
        });
        
        console.log(`📤 Sent positionUpdate to user ${userId}: ${eventType}`);
    } catch (e) {
        console.error(`Failed to notify user ${userId}:`, e.message);
    }
}

function getBinanceSymbol(product) {
    return product.replace("-", "").toLowerCase() + "t";
}

function normalizeGranularity(granularity) {
    const g = Number(granularity);
    return TIMEFRAMES.includes(g) ? g : 60;
}

function normalizePair(p) {
    if (!p) return "";
    return String(p).trim().replace("/", "-").toUpperCase();
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
let isProcessingTpSl = false;

app.post("/api/tp-sl/create", async (req, res) => {
    const { userId, positionId, orderType, triggerPrice, sizePercent } = req.body;

    if (!userId || !positionId || !orderType || !triggerPrice) {
        return res.json({ ok: false, error: "Missing required fields" });
    }

    if (!['TP', 'SL'].includes(orderType)) {
        return res.json({ ok: false, error: "Invalid order type" });
    }

    const trigger = Number(triggerPrice);
    const sizePct = Number(sizePercent) || 100;

    if (trigger <= 0) {
        return res.json({ ok: false, error: "Invalid trigger price" });
    }

    if (sizePct < MIN_PARTIAL_PERCENT || sizePct > 100) {
        return res.json({ ok: false, error: `Size must be between ${MIN_PARTIAL_PERCENT}% and 100%` });
    }

    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const posRes = await client.query(
            "SELECT * FROM positions WHERE id = $1 AND user_id = $2",
            [positionId, userId]
        );

        if (!posRes.rows.length) {
            await client.query("ROLLBACK");
            return res.json({ ok: false, error: "Position not found" });
        }

        const position = posRes.rows[0];
        const pair = normalizePair(position.pair);
        const posType = position.type.toUpperCase();
        const currentPrice = latestPrice[pair];

        if (currentPrice) {
            if (orderType === 'TP') {
                if (posType === 'LONG' && trigger <= currentPrice) {
                    await client.query("ROLLBACK");
                    return res.json({ ok: false, error: "TP must be above current price for LONG" });
                }
                if (posType === 'SHORT' && trigger >= currentPrice) {
                    await client.query("ROLLBACK");
                    return res.json({ ok: false, error: "TP must be below current price for SHORT" });
                }
            } else {
                if (posType === 'LONG' && trigger >= currentPrice) {
                    await client.query("ROLLBACK");
                    return res.json({ ok: false, error: "SL must be below current price for LONG" });
                }
                if (posType === 'SHORT' && trigger <= currentPrice) {
                    await client.query("ROLLBACK");
                    return res.json({ ok: false, error: "SL must be above current price for SHORT" });
                }
            }
        }

        const existingOrders = await client.query(
            "SELECT * FROM tp_sl_orders WHERE position_id = $1 AND status = 'ACTIVE'",
            [positionId]
        );

        const sameTypeOrders = existingOrders.rows.filter(o => o.order_type === orderType);
        const maxOrders = orderType === 'TP' ? MAX_TP_PER_POSITION : MAX_SL_PER_POSITION;

        if (sameTypeOrders.length >= maxOrders) {
            await client.query("ROLLBACK");
            return res.json({ ok: false, error: `Maximum ${maxOrders} ${orderType} orders reached` });
        }

        const usedPercent = sameTypeOrders.reduce((sum, o) => sum + Number(o.size_percent), 0);
        const availablePercent = 100 - usedPercent;

        if (sizePct > availablePercent) {
            await client.query("ROLLBACK");
            return res.json({ 
                ok: false, 
                error: "EXCEEDS_AVAILABLE_VOLUME",
                availablePercent: Math.floor(availablePercent)
            });
        }

        const insertRes = await client.query(`
            INSERT INTO tp_sl_orders (user_id, position_id, pair, order_type, trigger_price, size_percent, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
            RETURNING *
        `, [userId, positionId, pair, orderType, trigger, sizePct]);

        const newOrder = insertRes.rows[0];

        const allOrdersRes = await client.query(
            "SELECT * FROM tp_sl_orders WHERE position_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC",
            [positionId]
        );

        await client.query("COMMIT");

        console.log(`✅ ${orderType} order created: Position ${positionId}, Price ${trigger}, Size ${sizePct}%`);

        res.json({
            ok: true,
            order: newOrder,
            allOrders: allOrdersRes.rows
        });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("TP/SL Create Error:", e.message);
        res.json({ ok: false, error: "Database error" });
    } finally {
        client.release();
    }
});

app.post("/api/tp-sl/delete", async (req, res) => {
    const { userId, orderId } = req.body;

    if (!userId || !orderId) {
        return res.json({ ok: false, error: "Missing required fields" });
    }

    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const orderRes = await client.query(
            "SELECT * FROM tp_sl_orders WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'",
            [orderId, userId]
        );

        if (!orderRes.rows.length) {
            await client.query("ROLLBACK");
            return res.json({ ok: false, error: "Order not found or already processed" });
        }

        const order = orderRes.rows[0];
        const positionId = order.position_id;

        await client.query(
            "UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE id = $1",
            [orderId]
        );

        const allOrdersRes = await client.query(
            "SELECT * FROM tp_sl_orders WHERE position_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC",
            [positionId]
        );

        await client.query("COMMIT");

        console.log(`✅ TP/SL order ${orderId} cancelled`);

        res.json({
            ok: true,
            allOrders: allOrdersRes.rows
        });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("TP/SL Delete Error:", e.message);
        res.json({ ok: false, error: "Database error" });
    } finally {
        client.release();
    }
});

app.get("/api/tp-sl/list", async (req, res) => {
    const { userId, positionId } = req.query;

    if (!userId) {
        return res.json({ ok: false, error: "Missing userId" });
    }

    try {
        let query = "SELECT * FROM tp_sl_orders WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC";
        let params = [userId];

        if (positionId) {
            query = "SELECT * FROM tp_sl_orders WHERE user_id = $1 AND position_id = $2 AND status = 'ACTIVE' ORDER BY created_at ASC";
            params = [userId, positionId];
        }

        const result = await db.query(query, params);

        res.json({
            ok: true,
            orders: result.rows
        });

    } catch (e) {
        console.error("TP/SL List Error:", e.message);
        res.json({ ok: false, error: "Database error" });
    }
});

async function checkLiquidations() {
    if (isProcessingLiquidations || Object.keys(latestPrice).length === 0) return;

    isProcessingLiquidations = true;

    try {
        const res = await db.query(`SELECT * FROM positions`);

        if (res.rows.length === 0) {
            isProcessingLiquidations = false;
            return;
        }

        for (const pos of res.rows) {
            const pair = normalizePair(pos.pair);
            const currentPrice = latestPrice[pair];
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

        await client.query(
            "UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE position_id = $1 AND status = 'ACTIVE'",
            [pos.id]
        );

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

        await notifyUserPositionUpdate(pos.user_id, 'LIQUIDATION', {
            positionId: pos.id,
            pair: pos.pair,
            type: pos.type,
            pnl: pnlGross,
            exitPrice: exitPrice
        });

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("Liquidation DB Error:", e);
    } finally {
        client.release();
    }
}

async function checkTpSlOrders() {
    if (isProcessingTpSl || Object.keys(latestPrice).length === 0) return;

    isProcessingTpSl = true;

    try {
        const ordersRes = await db.query(
            "SELECT * FROM tp_sl_orders WHERE status = 'ACTIVE' ORDER BY created_at ASC"
        );

        if (ordersRes.rows.length === 0) {
            isProcessingTpSl = false;
            return;
        }

        const positionCache = new Map();

        for (const order of ordersRes.rows) {
            const pair = normalizePair(order.pair);
            const currentPrice = latestPrice[pair];
            if (!currentPrice) continue;

            let pos = positionCache.get(Number(order.position_id));
            if (!pos) {
                const posRes = await db.query("SELECT * FROM positions WHERE id = $1", [order.position_id]);
                if (!posRes.rows.length) {
                    await db.query("UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE id = $1", [order.id]);
                    continue;
                }
                pos = posRes.rows[0];
                positionCache.set(Number(pos.id), pos);
            }

            const posType = pos.type.toUpperCase();
            const triggerPrice = Number(order.trigger_price);
            let triggered = false;

            if (order.order_type === 'TP') {
                if (posType === 'LONG' && currentPrice >= triggerPrice) {
                    triggered = true;
                } else if (posType === 'SHORT' && currentPrice <= triggerPrice) {
                    triggered = true;
                }
            } else if (order.order_type === 'SL') {
                if (posType === 'LONG' && currentPrice <= triggerPrice) {
                    triggered = true;
                } else if (posType === 'SHORT' && currentPrice >= triggerPrice) {
                    triggered = true;
                }
            }

            if (triggered) {
                console.log(`🎯 ${order.order_type} TRIGGERED: Position ${order.position_id}, Price ${triggerPrice}, Current ${currentPrice}`);
                await executeTpSlOrder(order, pos, triggerPrice);
                positionCache.delete(Number(order.position_id));
            }
        }
    } catch (e) {
        console.error("TP/SL Engine Error:", e.message);
    } finally {
        isProcessingTpSl = false;
    }
}

async function executeTpSlOrder(order, pos, executionPrice) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const freshPos = await client.query(
            "SELECT * FROM positions WHERE id = $1 FOR UPDATE",
            [order.position_id]
        );

        if (!freshPos.rows.length) {
            await client.query("UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE id = $1", [order.id]);
            await client.query("COMMIT");
            return;
        }

        const position = freshPos.rows[0];
        const posSize = Number(position.size);
        const posMargin = Number(position.margin);
        const entryPrice = Number(position.entry_price);
        const sizePercent = Number(order.size_percent);
        const posType = position.type.toUpperCase();

        const closeSize = (posSize * sizePercent) / 100;
        const closeMargin = (posMargin * sizePercent) / 100;

        const priceChangePct = (executionPrice - entryPrice) / entryPrice;
        let pnl = priceChangePct * closeSize;
        if (posType === "SHORT") pnl = -pnl;

        const commission = closeSize * 0.0003;
        let totalReturn = closeMargin + pnl - commission;

        if (totalReturn < 0) totalReturn = 0;

        if (totalReturn > 0) {
            await client.query(
                "UPDATE users SET balance = balance + $1 WHERE user_id = $2",
                [totalReturn, position.user_id]
            );
        }

        await client.query(`
            INSERT INTO trades_history (user_id, pair, type, entry_price, exit_price, size, leverage, pnl, commission)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [position.user_id, position.pair, posType, entryPrice, executionPrice, closeSize, position.leverage, pnl, commission]);

        await client.query(
            "UPDATE tp_sl_orders SET status = 'TRIGGERED', triggered_at = CURRENT_TIMESTAMP WHERE id = $1",
            [order.id]
        );

        const isFullClose = sizePercent >= 99.99;
        const remainingSize = posSize - closeSize;
        const remainingMargin = posMargin - closeMargin;

        let positionClosed = false;

        if (isFullClose || remainingSize < 0.01 || remainingMargin < 0.01) {
            await client.query(
                "UPDATE tp_sl_orders SET status = 'CANCELLED' WHERE position_id = $1 AND status = 'ACTIVE'",
                [position.id]
            );
            await client.query("DELETE FROM positions WHERE id = $1", [position.id]);
            positionClosed = true;
        } else {
            await client.query(
                "UPDATE positions SET size = $1, margin = $2 WHERE id = $3",
                [remainingSize, remainingMargin, position.id]
            );

            const remainingOrders = await client.query(
                "SELECT * FROM tp_sl_orders WHERE position_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC",
                [position.id]
            );

            for (const remainingOrder of remainingOrders.rows) {
                const orderSizeAbs = (posSize * Number(remainingOrder.size_percent)) / 100;
                if (orderSizeAbs > remainingSize) {
                    const newPercent = Math.min(100, (remainingSize / posSize) * Number(remainingOrder.size_percent) * (posSize / remainingSize));
                    const cappedPercent = Math.min(100, Math.max(MIN_PARTIAL_PERCENT, newPercent));
                    await client.query(
                        "UPDATE tp_sl_orders SET size_percent = $1 WHERE id = $2",
                        [Math.round(cappedPercent * 100) / 100, remainingOrder.id]
                    );
                }
            }

            const sameTypeOrders = remainingOrders.rows.filter(o => o.order_type === order.order_type);
            let totalSamePercent = 0;
            for (const o of sameTypeOrders) {
                const updatedRes = await client.query("SELECT size_percent FROM tp_sl_orders WHERE id = $1", [o.id]);
                if (updatedRes.rows.length) {
                    totalSamePercent += Number(updatedRes.rows[0].size_percent);
                }
            }

            if (totalSamePercent > 100) {
                const scale = 100 / totalSamePercent;
                for (const o of sameTypeOrders) {
                    const updatedRes = await client.query("SELECT size_percent FROM tp_sl_orders WHERE id = $1", [o.id]);
                    if (updatedRes.rows.length) {
                        const newPct = Math.max(MIN_PARTIAL_PERCENT, Number(updatedRes.rows[0].size_percent) * scale);
                        await client.query(
                            "UPDATE tp_sl_orders SET size_percent = $1 WHERE id = $2",
                            [Math.round(newPct * 100) / 100, o.id]
                        );
                    }
                }
            }
        }

        await client.query("COMMIT");

        const pnlFormatted = pnl.toFixed(2);
        const isProfit = pnl >= 0;
        const emoji = order.order_type === 'TP' ? '🎯' : '🛡️';
        const typeLabel = order.order_type === 'TP' ? 'Take Profit' : 'Stop Loss';

        let msg;
        if (positionClosed) {
            msg = `${emoji} <b>${typeLabel} Triggered!</b>\n\n` +
                `Position <b>${posType} ${position.pair}</b> (x${position.leverage}) fully closed.\n\n` +
                `📊 Entry: ${entryPrice}\n` +
                `📊 Exit: ${executionPrice}\n` +
                `${isProfit ? '📈' : '📉'} PnL: ${isProfit ? '+' : ''}${pnlFormatted} VP\n` +
                `💸 Fee: ${commission.toFixed(2)} VP`;
        } else {
            msg = `${emoji} <b>Partial ${typeLabel} Triggered!</b>\n\n` +
                `Position <b>${posType} ${position.pair}</b> (x${position.leverage})\n` +
                `Closed ${sizePercent}% of position.\n\n` +
                `📊 Entry: ${entryPrice}\n` +
                `📊 Exit: ${executionPrice}\n` +
                `${isProfit ? '📈' : '📉'} PnL: ${isProfit ? '+' : ''}${pnlFormatted} VP\n` +
                `💸 Fee: ${commission.toFixed(2)} VP\n` +
                `📋 Remaining size: ${remainingSize.toFixed(2)} VP`;
        }

        sendTelegramAlert(position.user_id, msg);

        await notifyUserPositionUpdate(position.user_id, positionClosed ? 'TP_SL_FULL_CLOSE' : 'TP_SL_PARTIAL_CLOSE', {
            orderId: order.id,
            orderType: order.order_type,
            positionId: position.id,
            pair: position.pair,
            type: posType,
            pnl: pnl,
            sizePercent: sizePercent,
            executionPrice: executionPrice,
            positionClosed: positionClosed,
            remainingSize: positionClosed ? 0 : remainingSize,
            remainingMargin: positionClosed ? 0 : remainingMargin
        });

        console.log(`✅ ${order.order_type} executed: Position ${position.id}, PnL: ${pnlFormatted}, Size: ${sizePercent}%`);

    } catch (e) {
        await client.query("ROLLBACK");
        console.error("TP/SL Execution Error:", e.message);
    } finally {
        client.release();
    }
}

setInterval(checkLiquidations, 500);
setInterval(checkTpSlOrders, 500);

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

wss.on("connection", ws => {
    ws.subscriptions = new Set();
    ws.userId = null;

    ws.on("message", async raw => {
        try {
            const data = JSON.parse(raw.toString());

            if (data.type === "auth" && data.userId) {
                registerUserWebSocket(data.userId, ws);
                ws.send(JSON.stringify({ type: "authOk", userId: data.userId }));
                return;
            }

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

    ws.on("close", () => {
        unregisterUserWebSocket(ws);
    });

    ws.on("error", () => {
        unregisterUserWebSocket(ws);
    });
});

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

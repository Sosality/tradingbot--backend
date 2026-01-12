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

// === 🔥 ЗАГРУЗКА ИСТОРИИ (УЛУЧШЕННАЯ) 🔥 ===

// 1. Обычная загрузка "свежих" данных (последние 300 свечей)
async function loadHistoryFor(product, granularity = 60) {
    try {
        // Coinbase отдает максимум 300 свечей за раз
        const url = `${COINBASE_REST}/products/${product}/candles?granularity=${granularity}`;
        const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
        if (!r.ok) return;
        const chunk = await r.json();

        if (!historyStore[product]) historyStore[product] = {};
        
        // Преобразуем
        const newCandles = chunk.map(c => ({
            time: Math.floor(c[0]),
            open: Number(c[3]),
            high: Number(c[2]),
            low: Number(c[1]),
            close: Number(c[4]),
        })).sort((a, b) => a.time - b.time);

        // Мержим с тем, что уже есть (чтобы не потерять старые данные при обновлении)
        if (!historyStore[product][granularity]) {
            historyStore[product][granularity] = newCandles;
        } else {
            // Добавляем только новые (правые), если их нет
            const existing = historyStore[product][granularity];
            const lastTime = existing[existing.length - 1].time;
            const freshCandles = newCandles.filter(c => c.time > lastTime);
            historyStore[product][granularity] = [...existing, ...freshCandles];
        }

    } catch (e) { console.error(`Ошибка истории ${product} (${granularity}s):`, e.message); }
}

// 2. Загрузка СТАРЫХ данных (Пагинация назад)
async function fetchMoreHistoryFromCoinbase(product, granularity, beforeTime) {
    try {
        // Coinbase API принимает start и end в ISO формате
        // end = beforeTime (мы хотим данные ДО этого времени)
        // start = end - (300 свечей * granularity)
        
        const endTime = new Date(beforeTime * 1000).toISOString();
        const startTime = new Date((beforeTime - (300 * granularity)) * 1000).toISOString();

        const url = `${COINBASE_REST}/products/${product}/candles?granularity=${granularity}&start=${startTime}&end=${endTime}`;
        
        console.log(`🌐 Fetching external history: ${product} ${granularity}s | ${startTime} -> ${endTime}`);

        const r = await fetch(url, { headers: { "User-Agent": "TradeSimBot/1.0" } });
        
        if (!r.ok) {
            console.error(`External fetch failed: ${r.statusText}`);
            return [];
        }
        
        const chunk = await r.json();
        if (!Array.isArray(chunk) || chunk.length === 0) return [];

        const oldCandles = chunk.map(c => ({
            time: Math.floor(c[0]),
            open: Number(c[3]),
            high: Number(c[2]),
            low: Number(c[1]),
            close: Number(c[4]),
        })).sort((a, b) => a.time - b.time);

        // Вставляем эти данные в начало нашего кэша, чтобы потом не качать снова
        if (historyStore[product] && historyStore[product][granularity]) {
            // Фильтруем дубликаты на всякий случай
            const existing = historyStore[product][granularity];
            const firstExistingTime = existing[0].time;
            const uniqueOld = oldCandles.filter(c => c.time < firstExistingTime);
            
            historyStore[product][granularity] = [...uniqueOld, ...existing];
            return uniqueOld;
        }

        return oldCandles;

    } catch (e) {
        console.error("Error fetching more history:", e.message);
        return [];
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
                const granularity = data.timeframe || 60; // Default 1m

                // Send History
                if (historyStore[data.pair] && historyStore[data.pair][granularity]) {
                    // Отправляем последние 300 свечей, чтобы не грузить лишнее сразу
                    const fullHistory = historyStore[data.pair][granularity];
                    const initialData = fullHistory.slice(-300);
                    ws.send(JSON.stringify({
                        type: "history",
                        pair: data.pair,
                        data: initialData,
                        timeframe: granularity
                    }));
                } else {
                     // Try to load on demand if missing
                     await loadHistoryFor(data.pair, granularity);
                     if (historyStore[data.pair] && historyStore[data.pair][granularity]) {
                        const fullHistory = historyStore[data.pair][granularity];
                        ws.send(JSON.stringify({
                            type: "history",
                            pair: data.pair,
                            data: fullHistory.slice(-300),
                            timeframe: granularity
                        }));
                     }
                }

                if (latestPrice[data.pair]) ws.send(JSON.stringify({ type: "price", pair: data.pair, price: latestPrice[data.pair], ts: Date.now() }));
                if (orderbookStore[data.pair]) ws.send(JSON.stringify({ type: "orderBook", pair: data.pair, ...orderbookStore[data.pair] }));
                if (tradesStore[data.pair]) ws.send(JSON.stringify({ type: "trades", pair: data.pair, trades: tradesStore[data.pair].slice(-20) }));
            }

            // LOAD MORE HISTORY (LAZY LOADING)
            if (data.type === "loadMore" && PRODUCTS.includes(data.pair)) {
                const granularity = data.timeframe || 60;
                const oldestTime = data.until; // Timestamp of the leftmost visible candle

                console.log(`📥 loadMore request: ${data.pair} @ ${granularity}s, before ${new Date(oldestTime * 1000).toISOString()}`);

                let chunk = [];

                // 1. Проверяем кэш
                if (historyStore[data.pair] && historyStore[data.pair][granularity]) {
                    const fullHistory = historyStore[data.pair][granularity];
                    // Ищем свечи в кэше, которые старше (меньше) запрошенного времени
                    const cachedOlder = fullHistory.filter(c => c.time < oldestTime);
                    
                    if (cachedOlder.length >= 50) {
                        // Если в кэше достаточно старых данных, отдаем их
                        chunk = cachedOlder.slice(-300); // Берем последние 300 из старых
                        console.log(`📦 Serving ${chunk.length} candles from CACHE`);
                    }
                }

                // 2. Если в кэше пусто или мало, качаем извне
                if (chunk.length === 0) {
                    console.log(`🌍 Cache empty/insufficient, fetching from Coinbase...`);
                    chunk = await fetchMoreHistoryFromCoinbase(data.pair, granularity, oldestTime);
                    console.log(`📥 Fetched ${chunk.length} candles from EXTERNAL API`);
                }

                // ALWAYS send response
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

// === 🔄 АВТО-ОБНОВЛЕНИЕ ИСТОРИИ ===
cron.schedule("*/1 * * * *", async () => {
    // console.log("🔄 Updating Candle History...");
    for (const p of PRODUCTS) {
        for (const tf of TIMEFRAMES) {
             await loadHistoryFor(p, tf);
        }
    }
});

async function init() {
    for (const p of PRODUCTS) {
        for (const tf of TIMEFRAMES) {
            await loadHistoryFor(p, tf);
        }
    }
    connectBinanceWS();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🚀 PriceServer running on port ${PORT}`));
}

init();

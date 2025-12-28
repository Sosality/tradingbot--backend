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

// ————— CONFIG —————
const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const HISTORY_CANDLES = 1440;
const GRANULARITY = 60;

// ————— GLOBAL STATE —————
// Хранилище для свечей (истории) и сделок оставляем глобальным, так как оно простое
const historyStore = {};
const tradesStore = {};
const latestPrice = {};

// ————— ORDER BOOK LOGIC (REWRITTEN) —————
class OrderBookManager {
    constructor(product) {
        this.product = product;
        this.bids = new Map(); // Map<PriceString, SizeNumber>
        this.asks = new Map(); // Map<PriceString, SizeNumber>
        this.sequence = -1;    // Sequence ID from Coinbase
        this.isReady = false;  // Флаг готовности (Snapshot загружен)
        this.queue = [];       // Буфер для сообщений, пришедших ДО загрузки Snapshot
        this.lastHash = "";    // Хэш для проверки изменений (чтобы не спамить клиентов)
        
        // Автозапуск загрузки
        this.init();
    }

    async init() {
        console.log(`[${this.product}] 🔄 Starting OrderBook sync...`);
        // 1. Сразу после создания (и подписки на сокет) мы начинаем копить сообщения в queue.
        // 2. Параллельно запрашиваем Snapshot.
        await this.fetchSnapshot();
    }

    async fetchSnapshot() {
        try {
            // Level 2 дает топ 50 заявок, для UI этого достаточно и это быстро
            // Level 3 дает ВСЕ заявки, но это тяжело. Для симулятора Level 2 ок, но 
            // чтобы стакан жил долго, лучше иногда брать Level 3 или периодически ресинхронить.
            // Здесь используем level=2 для скорости старта.
            const response = await fetch(`${COINBASE_REST}/products/${this.product}/book?level=2`, {
                headers: { "User-Agent": "TradeSim/1.0", "Accept": "application/json" }
            });
            
            if (!response.ok) throw new Error(`Status ${response.status}`);
            const data = await response.json();

            // Очищаем и заполняем
            this.bids.clear();
            this.asks.clear();
            this.sequence = data.sequence;

            data.bids.forEach(bid => this.bids.set(String(bid[0]), Number(bid[1])));
            data.asks.forEach(ask => this.asks.set(String(ask[0]), Number(ask[1])));

            console.log(`[${this.product}] ✅ Snapshot loaded (Seq: ${this.sequence}). Processing buffer (${this.queue.length} items)...`);
            
            this.isReady = true;
            this.processQueue(); // Применяем всё, что накопилось пока качали снапшот

        } catch (e) {
            console.error(`[${this.product}] ❌ Snapshot failed: ${e.message}. Retrying in 5s...`);
            setTimeout(() => this.fetchSnapshot(), 5000);
        }
    }

    // Обработка сообщений из WebSocket
    handleUpdate(msg) {
        // Если снапшот еще не загружен, складываем в буфер
        if (!this.isReady) {
            this.queue.push(msg);
            // Защита от переполнения памяти, если снапшот завис
            if (this.queue.length > 5000) this.queue.shift(); 
            return;
        }

        this.applyChanges(msg);
    }

    // Применение накопленного буфера
    processQueue() {
        for (const msg of this.queue) {
            this.applyChanges(msg);
        }
        this.queue = [];
    }

    // Ядро логики обновления
    applyChanges(msg) {
        // Coinbase Sequence Check:
        // Если пришло сообщение старее, чем наш снапшот — игнорируем его.
        if (msg.sequence <= this.sequence) return;

        // В идеале msg.sequence должно быть === this.sequence + 1.
        // Если разрыв большой, по-хорошему надо перезагружать стакан. 
        // Но для симулятора просто обновляем sequence.
        this.sequence = msg.sequence;

        if (msg.changes) {
            for (const [side, priceStr, sizeStr] of msg.changes) {
                const size = Number(sizeStr);
                const map = side === 'buy' ? this.bids : this.asks;
                
                if (size === 0) {
                    map.delete(priceStr);
                } else {
                    map.set(priceStr, size);
                }
            }
        }
    }

    // Получение данных для клиента (топ-15)
    getClientData() {
        if (!this.isReady) return null;

        // Превращаем Map в Array и сортируем
        // Bids (покупатели) — по убыванию цены (кто платит больше — тот первый)
        const bidsArr = Array.from(this.bids.entries())
            .map(([p, s]) => ({ price: Number(p), size: s }))
            .sort((a, b) => b.price - a.price)
            .slice(0, 15);

        // Asks (продавцы) — по возрастанию цены (кто продает дешевле — тот первый)
        const asksArr = Array.from(this.asks.entries())
            .map(([p, s]) => ({ price: Number(p), size: s }))
            .sort((a, b) => a.price - b.price)
            .slice(0, 15);

        // Генерируем хэш, чтобы понять, изменилось ли что-то визуально
        const currentHash = JSON.stringify({ b: bidsArr[0], a: asksArr[0], len: bidsArr.length + asksArr.length });
        
        // Оптимизация трафика: если топ стакана не изменился, возвращаем null (не слать апдейт)
        // Раскомментируй проверку ниже, если хочешь экономить трафик
        /*
        if (currentHash === this.lastHash) return null;
        this.lastHash = currentHash;
        */

        return { buy: bidsArr, sell: asksArr };
    }
}

// Создаем менеджеры для каждой пары
const orderBooks = {};
PRODUCTS.forEach(p => {
    orderBooks[p] = new OrderBookManager(p);
});

// ————— UTILS (HISTORY) —————
function mapCandlesFromCoinbase(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(c => ({
        time: Math.floor(c[0]),
        low: c[1], high: c[2], open: c[3], close: c[4]
    })).sort((a, b) => a.time - b.time);
}

async function loadHistoryFor(product) {
    console.log(`[${product}] 🕯 Fetching history...`);
    // Упрощенная загрузка без сложных чанков для стабильности при старте
    const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}`;
    try {
        const r = await fetch(url, { headers: { "User-Agent": "TradeSim/1.0" } });
        if (!r.ok) throw new Error(r.statusText);
        const data = await r.json();
        historyStore[product] = mapCandlesFromCoinbase(data).slice(-300); // Берем последние 300 свечей
        console.log(`[${product}] 🕯 History loaded (${historyStore[product].length} candles)`);
    } catch (e) {
        console.error(`[${product}] History error:`, e.message);
    }
}

// ————— WEBSOCKET COINBASE —————
let cbWs;
function connectCoinbase() {
    console.log("🔌 Connecting to Coinbase WS...");
    cbWs = new WebSocket(COINBASE_WS);

    cbWs.on('open', () => {
        console.log("✅ Coinbase WS Connected");
        const msg = {
            type: "subscribe",
            product_ids: PRODUCTS,
            channels: ["ticker", "level2", "matches"]
        };
        cbWs.send(JSON.stringify(msg));
    });

    cbWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (!msg.product_id) return;

            const pair = msg.product_id;

            // 1. OrderBook Update
            if (msg.type === 'l2update' || msg.type === 'snapshot') {
                if (orderBooks[pair]) {
                    orderBooks[pair].handleUpdate(msg);
                }
            }

            // 2. Ticker / Price
            if (msg.type === 'ticker') {
                latestPrice[pair] = Number(msg.price);
                broadcast({ type: 'price', pair, price: latestPrice[pair] });
            }

            // 3. Trades
            if (msg.type === 'match' || msg.type === 'last_match') {
                if (!tradesStore[pair]) tradesStore[pair] = [];
                tradesStore[pair].push({
                    price: Number(msg.price),
                    size: Number(msg.size),
                    side: msg.side,
                    time: new Date(msg.time).getTime()
                });
                if (tradesStore[pair].length > 50) tradesStore[pair].shift();
                
                // Сделки шлем сразу, они нужны в реалтайме
                broadcast({ type: 'trades', pair, trades: tradesStore[pair].slice(-20) });
            }

        } catch (e) {
            console.error("Parse Error:", e);
        }
    });

    cbWs.on('close', () => {
        console.log("⚠️ Coinbase WS Closed. Reconnecting...");
        setTimeout(connectCoinbase, 2000);
    });
    
    cbWs.on('error', (err) => console.error("Coinbase WS Error:", err.message));
}

// ————— BROADCAST LOOP (200ms) —————
// Отдельный цикл отправки стакана, чтобы не перегружать канал на каждый чих сокета
setInterval(() => {
    PRODUCTS.forEach(pair => {
        if (!orderBooks[pair]) return;
        
        const bookData = orderBooks[pair].getClientData();
        if (bookData) {
            // Если данные есть, отправляем всем подписчикам
            broadcast({
                type: "orderBook",
                pair: pair,
                buy: bookData.buy,
                sell: bookData.sell
            });
        }
    });
}, 200);

// ————— HELPER: Broadcast to Clients —————
function broadcast(msg) {
    const msgStr = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // Если у сообщения есть pair, проверяем подписку клиента
            if (msg.pair && client.subscription !== msg.pair) return;
            client.send(msgStr);
        }
    });
}

// ————— CLIENT SERVER —————
wss.on('connection', (ws) => {
    ws.subscription = null; // Храним текущую пару клиента прямо в объекте сокета

    ws.on('message', (message) => {
        try {
            const req = JSON.parse(message);

            if (req.type === 'subscribe') {
                ws.subscription = req.pair;
                console.log(`👤 Client subscribed to ${req.pair}`);

                // 1. Send History
                if (historyStore[req.pair]) {
                    ws.send(JSON.stringify({ type: 'history', pair: req.pair, data: historyStore[req.pair] }));
                }

                // 2. Send Price
                if (latestPrice[req.pair]) {
                    ws.send(JSON.stringify({ type: 'price', pair: req.pair, price: latestPrice[req.pair] }));
                }

                // 3. Send Initial OrderBook
                if (orderBooks[req.pair]) {
                    const book = orderBooks[req.pair].getClientData();
                    if (book) {
                        ws.send(JSON.stringify({ type: "orderBook", pair: req.pair, buy: book.buy, sell: book.sell }));
                    }
                }
            }

            if (req.type === 'unsubscribe') {
                ws.subscription = null;
            }

        } catch (e) {
            console.error("Client Msg Error:", e);
        }
    });
});

// ————— INIT —————
(async function start() {
    console.log("🚀 Server Starting...");
    
    // Загружаем историю для графиков
    for (const p of PRODUCTS) {
        await loadHistoryFor(p);
    }

    // Подключаемся к Coinbase (это запустит и сборку стаканов)
    connectCoinbase();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Listening on ${PORT}`));
})();

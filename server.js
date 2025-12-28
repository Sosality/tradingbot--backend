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
const GRANULARITY = 60;

// ————— GLOBAL STATE —————
const historyStore = {};
const tradesStore = {};
const latestPrice = {};

// ————— ORDER BOOK MANAGER —————
class OrderBookManager {
    constructor(product) {
        this.product = product;
        this.bids = new Map(); 
        this.asks = new Map(); 
        this.isReady = false;  
        this.snapshotSequence = -1;
        
        // Запускаем синхронизацию сразу
        this.init();
    }

    async init() {
        await this.fetchSnapshot();
    }

    async fetchSnapshot() {
        try {
            console.log(`[${this.product}] 📥 Downloading Snapshot...`);
            const response = await fetch(`${COINBASE_REST}/products/${this.product}/book?level=2`, {
                headers: { "User-Agent": "TradeSim/1.0", "Accept": "application/json" }
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            // Критическая секция: очистка и заполнение
            this.bids.clear();
            this.asks.clear();
            this.snapshotSequence = data.sequence;

            // Принудительно приводим ключи к String, чтобы избежать дублей (100 !== "100")
            if (Array.isArray(data.bids)) {
                data.bids.forEach(x => this.bids.set(String(x[0]), Number(x[1])));
            }
            if (Array.isArray(data.asks)) {
                data.asks.forEach(x => this.asks.set(String(x[0]), Number(x[1])));
            }

            this.isReady = true;
            console.log(`[${this.product}] ✅ Ready. Bids: ${this.bids.size}, Asks: ${this.asks.size}`);
        } catch (e) {
            console.error(`[${this.product}] Snapshot Error: ${e.message}. Retrying...`);
            setTimeout(() => this.fetchSnapshot(), 3000);
        }
    }

    handleUpdate(msg) {
        if (!this.isReady) return;

        // ЛОГИКА "ЖИВОГО" СТАКАНА
        // Мы игнорируем старые пакеты, которые пришли ДО снапшота (sequence <= snapshotSequence).
        // Но для всех новых пакетов мы применяем изменения безусловно.
        // Это предотвращает "зависание", если Coinbase пропустит один пакет последовательности.
        
        if (msg.sequence <= this.snapshotSequence) return;

        if (msg.changes && Array.isArray(msg.changes)) {
            for (const change of msg.changes) {
                // Формат: [ "buy", "100.50", "0.01" ]
                const side = change[0];
                const priceStr = String(change[1]); // Принудительно строка
                const sizeNum = Number(change[2]);  // Принудительно число

                const map = (side === 'buy') ? this.bids : this.asks;

                if (sizeNum === 0) {
                    map.delete(priceStr);
                } else {
                    map.set(priceStr, sizeNum);
                }
            }
        }
    }

    getClientData() {
        if (!this.isReady) return null;

        // Превращаем Map в Array и сортируем
        // Bids (покупатели) — по убыванию цены
        const bidsArr = Array.from(this.bids.entries())
            .map(([p, s]) => ({ price: Number(p), size: s }))
            .sort((a, b) => b.price - a.price)
            .slice(0, 15);

        // Asks (продавцы) — по возрастанию цены
        const asksArr = Array.from(this.asks.entries())
            .map(([p, s]) => ({ price: Number(p), size: s }))
            .sort((a, b) => a.price - b.price)
            .slice(0, 15);

        return { buy: bidsArr, sell: asksArr };
    }
}

// Создаем менеджеры
const orderBooks = {};
PRODUCTS.forEach(p => orderBooks[p] = new OrderBookManager(p));

// ————— WEBSOCKET COINBASE —————
let cbWs;
function connectCoinbase() {
    console.log("🔌 Connecting to Coinbase WS...");
    cbWs = new WebSocket(COINBASE_WS);

    cbWs.on('open', () => {
        console.log("✅ Coinbase WS Open");
        cbWs.send(JSON.stringify({
            type: "subscribe",
            product_ids: PRODUCTS,
            channels: ["ticker", "level2", "matches"]
        }));
    });

    cbWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (!msg.product_id) return;

            const pair = msg.product_id;

            // 1. OrderBook Logic
            if (msg.type === 'l2update' || msg.type === 'snapshot') {
                if (orderBooks[pair]) orderBooks[pair].handleUpdate(msg);
            }

            // 2. Price / Ticker
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
                broadcast({ type: 'trades', pair, trades: tradesStore[pair].slice(-15) });
            }

        } catch (e) {
            console.error("WS Parse Error:", e);
        }
    });

    cbWs.on('close', () => setTimeout(connectCoinbase, 3000));
    cbWs.on('error', (e) => console.error("WS Error:", e.message));
}

// ————— HISTORY LOADER —————
async function loadHistoryFor(product) {
    try {
        const url = `${COINBASE_REST}/products/${product}/candles?granularity=${GRANULARITY}`;
        const r = await fetch(url, { headers: { "User-Agent": "TradeSim/1.0" } });
        if(r.ok) {
            const data = await r.json();
            historyStore[product] = data.map(c => ({
                time: Math.floor(c[0]), low: c[1], high: c[2], open: c[3], close: c[4]
            })).sort((a,b)=>a.time-b.time).slice(-300);
            console.log(`[${product}] History loaded`);
        }
    } catch(e) { console.error(`History fail ${product}`); }
}

// ————— BROADCAST LOOP (Interval 200ms) —————
// Это сердце обновлений. Раз в 200мс мы берем текущее состояние стакана и шлем его.
setInterval(() => {
    PRODUCTS.forEach(pair => {
        if (orderBooks[pair]) {
            const data = orderBooks[pair].getClientData();
            if (data) {
                // Отправляем объект с полями buy/sell, которые ждет клиент
                broadcast({ type: "orderBook", pair, buy: data.buy, sell: data.sell });
            }
        }
    });
}, 200);

function broadcast(msg) {
    const msgStr = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (msg.pair && client.subscription !== msg.pair) return;
            client.send(msgStr);
        }
    });
}

// ————— CLIENT WS —————
wss.on('connection', (ws) => {
    ws.subscription = null;
    ws.on('message', (msgRaw) => {
        try {
            const req = JSON.parse(msgRaw);
            if (req.type === 'subscribe') {
                ws.subscription = req.pair;
                
                // Сразу шлем всё, что есть
                if (historyStore[req.pair]) ws.send(JSON.stringify({ type: 'history', pair: req.pair, data: historyStore[req.pair] }));
                if (latestPrice[req.pair]) ws.send(JSON.stringify({ type: 'price', pair: req.pair, price: latestPrice[req.pair] }));
                if (orderBooks[req.pair]) {
                    const ob = orderBooks[req.pair].getClientData();
                    if(ob) ws.send(JSON.stringify({ type: "orderBook", pair: req.pair, buy: ob.buy, sell: ob.sell }));
                }
            }
        } catch(e){}
    });
});

// ————— INIT —————
(async () => {
    await Promise.all(PRODUCTS.map(loadHistoryFor));
    connectCoinbase();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
})();

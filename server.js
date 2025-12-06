import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

// === Исторические данные (OHLC) ===
// Coinbase поддерживает granularity: 60, 300, 900, 3600, 21600, 86400
app.get("/history", async (req, res) => {
    try {
        const granularity = 60; // 1 минута
        const now = Math.floor(Date.now() / 1000);
        const start = now - 60 * 300; // последние 300 минут

        const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}&start=${start}&end=${now}`;

        const r = await fetch(url);
        const data = await r.json();

        // Coinbase отдаёт свечи в формате:
        // [ time, low, high, open, close, volume ]
        const candles = data.reverse().map(c => ({
            time: c[0],
            open: c[3],
            high: c[2],
            low: c[1],
            close: c[4]
        }));

        res.json({ ok: true, candles });

    } catch (err) {
        console.error(err);
        res.json({ ok: false, error: err.message });
    }
});

// === Real-time WebSocket Coinbase feed → our WS server ===
const server = app.listen(8081, () => {
    console.log("Price server running on 8081");
});

const wss = new WebSocketServer({ server });

let clients = new Set();

// Подключение клиентов
wss.on("connection", ws => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "connection", ok: true }));

    ws.on("close", () => clients.delete(ws));
});


// === Подключаемся к Coinbase WS ===
const cb = new WebSocket("wss://ws-feed.exchange.coinbase.com");

cb.on("open", () => {
    console.log("Connected to Coinbase");
    cb.send(JSON.stringify({
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: ["ticker"]
    }));
});

cb.on("message", msg => {
    try {
        const data = JSON.parse(msg);

        if (!data.price) return;

        const payload = JSON.stringify({
            type: "price",
            price: Number(data.price),
            time: Date.now()
        });

        // Рассылаем всем клиентам
        for (const c of clients) c.send(payload);

    } catch (e) {
        console.error("Parse error:", e);
    }
});

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import WebSocketClient from "ws"; // для Coinbase

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ========== FRONTEND WS SERVER ==========
wss.on("connection", (ws) => {
    console.log("🎉 Клиент подключился к WS");

    ws.send(JSON.stringify({ type: "hello", msg: "WS OK" }));

    ws.on("close", () => {
        console.log("❌ Клиент отключился");
    });
});

function broadcast(data) {
    const json = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(json);
    });
}

// ========== PRICE DATA ==========
let currentPrice = 0;
let candleHistory = []; // для графика

function connectCoinbase() {
    const ws = new WebSocketClient("wss://ws-feed.exchange.coinbase.com");

    ws.on("open", () => {
        console.log("📡 Coinbase подключен");

        // Подписка на тикер и свечи
        ws.send(JSON.stringify({
            type: "subscribe",
            product_ids: ["BTC-USD"],
            channels: ["ticker", "candles"]
        }));
    });

    ws.on("message", (msg) => {
        const data = JSON.parse(msg);

        // Текущая цена
        if (data.type === "ticker" && data.price) {
            currentPrice = Number(data.price);
            broadcast({
                type: "price",
                symbol: "BTC-USD",
                price: currentPrice,
                ts: Date.now()
            });
        }

        // История свечей
        if (data.type === "candles" && data.data) {
            // data.data = [{time, open, high, low, close}]
            candleHistory = data.data.map(c => ({
                time: c.time, open: c.open, high: c.high, low: c.low, close: c.close
            }));
            broadcast({ type: "history", data: candleHistory });
        }
    });

    ws.on("close", () => {
        console.log("⚠ Coinbase отключился. Переподключение через 5 сек...");
        setTimeout(connectCoinbase, 5000);
    });

    ws.on("error", (e) => console.log("Coinbase WS error:", e));
}

connectCoinbase();

// ========== HTTP ENDPOINT ==========
app.get("/price", (req, res) => {
    res.json({ price: currentPrice, candles: candleHistory });
});

// ========== RUN SERVER ==========
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`WS Price Server B running on ${PORT}`));

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import WebSocketClient from "ws"; // Coinbase WS для тикеров
import fetch from "node-fetch";  // для REST свечей

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(data) {
    const json = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(json);
    });
}

let currentPrice = 0;
let candleHistory = [];

// ========== REST ЗАПРОС СВЕЧЕЙ ==========
async function loadCandles() {
    try {
        const res = await fetch(
            "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60"
        );
        const data = await res.json();

        // Coinbase отдаёт массив: [ time, low, high, open, close ]
        candleHistory = data
            .reverse()
            .map(c => ({
                time: c[0],
                open: c[3],
                high: c[2],
                low: c[1],
                close: c[4]
            }));

        broadcast({ type: "history", data: candleHistory });
    } catch (e) {
        console.log("Ошибка загрузки свечей:", e);
    }
}

setInterval(loadCandles, 5000);
loadCandles();

// ========== ТИКЕРЫ ЧЕРЕЗ WS ==========
function connectCoinbase() {
    const ws = new WebSocketClient("wss://ws-feed.exchange.coinbase.com");

    ws.on("open", () => {
        console.log("📡 Coinbase подключен");

        ws.send(JSON.stringify({
            type: "subscribe",
            product_ids: ["BTC-USD"],
            channels: ["ticker"]
        }));
    });

    ws.on("message", (raw) => {
        let data = {};
        try { data = JSON.parse(raw); } catch { return; }

        if (data.type === "ticker" && data.price) {
            currentPrice = Number(data.price);
            broadcast({
                type: "price",
                price: currentPrice,
                ts: Date.now()
            });
        }
    });

    ws.on("close", () => {
        console.log("⚠ Coinbase отключился. Переподключение...");
        setTimeout(connectCoinbase, 3000);
    });

    ws.on("error", e => console.log("WS error:", e));
}

connectCoinbase();

// ========== HTTP ==========
app.get("/price", (req, res) => {
    res.json({ price: currentPrice, candles: candleHistory });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`WS Price Server B running on ${PORT}`));

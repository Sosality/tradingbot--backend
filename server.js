import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";   // <-- ВАЖНО
import cors from "cors";
import WebSocketClient from "ws";       // <-- для подключения к Coinbase

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// =======================================================
//  WEBSOCKET SERVER ДЛЯ ФРОНТЕНДА
// =======================================================

const wss = new WebSocketServer({ server });

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

// =======================================================
//  ПОЛУЧЕНИЕ BTC ЦЕНЫ (Coinbase)
// =======================================================

let currentPrice = 0;

function connectCoinbase() {
    const ws = new WebSocketClient("wss://ws-feed.exchange.coinbase.com");

    ws.on("open", () => {
        console.log("📡 Coinbase подключен");
        ws.send(
            JSON.stringify({
                type: "subscribe",
                product_ids: ["BTC-USD"],
                channels: ["ticker"],
            })
        );
    });

    ws.on("message", (msg) => {
        const data = JSON.parse(msg);
        if (data.type === "ticker" && data.price) {
            currentPrice = Number(data.price);

            broadcast({
                type: "price",
                symbol: "BTC",
                price: currentPrice,
                ts: Date.now(),
            });
        }
    });

    ws.on("close", () => {
        console.log("⚠ Coinbase отключился. Переподключение...");
        setTimeout(connectCoinbase, 5000);
    });

    ws.on("error", (e) => console.log("Coinbase error:", e));
}

connectCoinbase();

// =======================================================
//  HTTP ENDPOINT — текущая цена
// =======================================================

app.get("/price", (req, res) => {
    res.json({ price: currentPrice });
});

// =======================================================
//  RUN SERVER
// =======================================================

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`WS Price Server running on ${PORT}`));

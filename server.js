// price-server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import cors from "cors";
import WebSocketClient from "ws"; // для подключения к Coinbase

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ========================
// Internal state
// ========================
let currentPrice = 0;
let candleHistory = []; // [{ time: <unix seconds>, open, high, low, close }]
let orderBook = { buy: [], sell: [] }; // top levels
let recentTrades = []; // array of latest trades {price,size,side,time}
const MAX_TRADES = 200;

// ========================
// Utility: broadcast to all clients
// ========================
function broadcast(obj) {
  const j = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try { client.send(j); } catch (e) { /* ignore */ }
    }
  }
}

// ========================
// When a client connects -> send current state
// ========================
wss.on("connection", (ws, req) => {
  console.log("WS client connected", req.socket.remoteAddress);

  // hello
  ws.send(JSON.stringify({ type: "hello", msg: "price-ws OK" }));

  // send current price
  if (currentPrice && currentPrice > 0) {
    ws.send(JSON.stringify({ type: "price", price: currentPrice, ts: Date.now() }));
  }

  // send history (candles)
  if (candleHistory && candleHistory.length) {
    ws.send(JSON.stringify({ type: "history", data: candleHistory }));
  }

  // send orderbook snapshot
  ws.send(JSON.stringify({ type: "orderbook", buy: orderBook.buy, sell: orderBook.sell }));

  // send recent trades
  ws.send(JSON.stringify({ type: "trades", data: recentTrades.slice(-50) }));

  ws.on("message", msg => {
    // optional: clients might request something
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed && parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }
    } catch (e) {}
  });

  ws.on("close", () => console.log("WS client disconnected"));
});

// ========================
// Load initial candle history from Binance (public REST)
// ========================
async function loadInitialCandles() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=200");
    if (!res.ok) throw new Error("binance klines failed " + res.status);
    const data = await res.json();
    // data: [[openTime, open, high, low, close, ...], ...]
    candleHistory = data.map(c => ({
      time: Math.floor(c[0] / 1000), // unix seconds
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4])
    }));
    if (candleHistory.length) {
      currentPrice = candleHistory[candleHistory.length - 1].close;
    }
    console.log("Loaded", candleHistory.length, "candles from Binance");
  } catch (e) {
    console.warn("Failed loading initial candles:", e.message);
    candleHistory = [];
  }
}

// ========================
// Coinbase WebSocket connection
// ========================
function connectCoinbase() {
  const ws = new WebSocketClient("wss://ws-feed.exchange.coinbase.com");

  ws.on("open", () => {
    console.log("Connected to Coinbase WS, subscribing...");
    // subscribe to ticker, level2 (orderbook), matches (trades)
    ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker", "level2", "matches"]
    }));
  });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    // Ticker: current price
    if (data.type === "ticker" && data.price) {
      const p = Number(data.price);
      if (isFinite(p) && p > 0) {
        currentPrice = p;
        broadcast({ type: "price", price: currentPrice, ts: Date.now() });
        // also update candleHistory last candle's close if same minute OR create new minute candle
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const minute = Math.floor(nowSec / 60) * 60;
          const last = candleHistory[candleHistory.length - 1];
          if (!last || last.time !== minute) {
            // push new candle (open/high/low/close based on price)
            const newCandle = { time: minute, open: p, high: p, low: p, close: p };
            candleHistory.push(newCandle);
            // keep last 500 candles max
            if (candleHistory.length > 1000) candleHistory.shift();
            // broadcast new minute start as candle_update
            broadcast({ type: "candle_update", data: newCandle });
          } else {
            // update last candle
            last.high = Math.max(last.high, p);
            last.low = Math.min(last.low, p);
            last.close = p;
            broadcast({ type: "candle_update", data: last });
          }
        } catch(e){}
      }
    }

    // Level2 snapshot: initial orderbook
    if (data.type === "snapshot" && data.product_id === "BTC-USD") {
      // data.bids = [[price, size], ...] (strings)
      const buys = (data.bids || []).map(b => ({ price: Number(b[0]), size: Number(b[1]) }));
      const sells = (data.asks || []).map(a => ({ price: Number(a[0]), size: Number(a[1]) }));
      // keep top 50 each (desc buys, asc sells)
      orderBook.buy = buys.slice(0, 100).sort((a,b)=>b.price-a.price);
      orderBook.sell = sells.slice(0, 100).sort((a,b)=>a.price-b.price);
      broadcast({ type: "orderbook", buy: orderBook.buy.slice(0,50), sell: orderBook.sell.slice(0,50) });
    }

    // Level2 updates: l2update -> changes: [[side, price, size], ...]
    if (data.type === "l2update" && Array.isArray(data.changes)) {
      data.changes.forEach(ch => {
        const [side, priceStr, sizeStr] = ch;
        const price = Number(priceStr);
        const size = Number(sizeStr);
        if (!isFinite(price)) return;
        if (side === "buy") {
          // update buy side: replace price level or add/remove if size=0
          const idx = orderBook.buy.findIndex(x=>x.price===price);
          if (size === 0) {
            if (idx !== -1) orderBook.buy.splice(idx,1);
          } else {
            if (idx === -1) orderBook.buy.push({ price, size });
            else orderBook.buy[idx].size = size;
          }
          orderBook.buy.sort((a,b)=>b.price-a.price);
          orderBook.buy = orderBook.buy.slice(0,200);
        } else { // sell
          const idx = orderBook.sell.findIndex(x=>x.price===price);
          if (size === 0) {
            if (idx !== -1) orderBook.sell.splice(idx,1);
          } else {
            if (idx === -1) orderBook.sell.push({ price, size });
            else orderBook.sell[idx].size = size;
          }
          orderBook.sell.sort((a,b)=>a.price-b.price);
          orderBook.sell = orderBook.sell.slice(0,200);
        }
      });
      broadcast({ type: "orderbook", buy: orderBook.buy.slice(0,50), sell: orderBook.sell.slice(0,50) });
    }

    // Matches -> trade events
    if (data.type === "match" && data.product_id === "BTC-USD") {
      const t = {
        price: Number(data.price),
        size: Number(data.size),
        side: data.side, // 'buy' means taker side buy
        time: data.time
      };
      if (isFinite(t.price) && t.price > 0) {
        recentTrades.push(t);
        if (recentTrades.length > MAX_TRADES) recentTrades.shift();
        broadcast({ type: "trade", data: t });
      }
    }
  });

  ws.on("close", () => {
    console.log("Coinbase WS closed — reconnecting in 5s");
    setTimeout(connectCoinbase, 5000);
  });

  ws.on("error", (e) => {
    console.log("Coinbase WS error:", e && e.message ? e.message : e);
  });
}

// ========================
// HTTP endpoints
// ========================
app.get("/price", (req, res) => {
  res.json({ price: currentPrice, candles: candleHistory.slice(-200) });
});

app.get("/orderbook", (req, res) => {
  res.json({ buy: orderBook.buy.slice(0,50), sell: orderBook.sell.slice(0,50) });
});

app.get("/trades", (req, res) => {
  res.json({ trades: recentTrades.slice(-200) });
});

// ========================
// Start server
// ========================
const PORT = process.env.PORT || 8080;
await loadInitialCandles();
connectCoinbase();

server.listen(PORT, () => {
  console.log(`Price WebSocket server running on port ${PORT}`);
});

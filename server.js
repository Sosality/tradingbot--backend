/**
 * price-server.js
 * WS server that streams BTC-USD price & minute candles.
 *
 * Usage: node price-server.js
 */

import WebSocket from "ws";
import http from "http";

// Coinbase WS endpoint
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

// Port for our WS server
const PORT = process.env.PRICE_WS_PORT ? Number(process.env.PRICE_WS_PORT) : 4000;

// In-memory storage
let candles = []; // {time: unixSec, open, high, low, close}
let currentCandle = null;
let lastPrice = 0;
let trades = []; // recent trades
let orderBook = { buy: [], sell: [] }; // simulated small book

// Connect to Coinbase
function connectCoinbase() {
  const ws = new WebSocket(COINBASE_WS);

  ws.on("open", () => {
    console.log("Connected to Coinbase WS. Subscribing to BTC-USD ticker...");
    ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: ["BTC-USD"],
      channels: ["ticker"]
    }));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ticker" && msg.product_id === "BTC-USD") {
        const p = parseFloat(msg.price);
        const t = Math.floor(Date.now() / 1000);
        onPriceTick(p, t, msg);
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    console.log("Coinbase WS closed. Reconnect in 5s...");
    setTimeout(connectCoinbase, 5000);
  });

  ws.on("error", (err) => {
    console.error("Coinbase WS error:", err.message || err);
  });
}

function onPriceTick(price, unixSec, rawMsg) {
  if (!currentCandle) {
    const minute = Math.floor(unixSec / 60) * 60;
    currentCandle = { time: minute, open: price, high: price, low: price, close: price };
  } else {
    const minute = Math.floor(unixSec / 60) * 60;
    if (minute !== currentCandle.time) {
      // push previous and start new
      candles.push(currentCandle);
      if (candles.length > 500) candles.shift();
      currentCandle = { time: minute, open: price, high: price, low: price, close: price };
    } else {
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
    }
  }
  lastPrice = price;

  // push trade snapshot to recent trades (simulate)
  trades.push({ price, size: (Math.random()*0.01)+0.001, side: (Math.random()>0.5?'buy':'sell'), time: Date.now() });
  if (trades.length > 200) trades.shift();

  // generate small simulated order book near price
  generateOrderBook(price);

  // broadcast to clients
  broadcast({
    type: "price",
    data: { price: lastPrice, change24h: 0 } // change24h left as 0; could be calculated via external API
  });

  broadcast({
    type: "trades",
    data: trades.slice(-50)
  });

  // send current candle update
  if (currentCandle) {
    broadcast({ type: "candle_update", data: currentCandle });
  }
}

function generateOrderBook(mid) {
  const levels = 12;
  const spread = Math.max(1, mid * 0.002); // ~0.2%
  const buy = [];
  const sell = [];
  for (let i=levels; i>=1; i--) {
    buy.push({ price: +(mid - i * spread).toFixed(2), size: +(Math.random()*1).toFixed(4) });
  }
  for (let i=1; i<=levels; i++) {
    sell.push({ price: +(mid + i * spread).toFixed(2), size: +(Math.random()*1).toFixed(4) });
  }
  orderBook = { buy, sell };
}

// Simple WS server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(s);
  });
}

wss.on("connection", (ws, req) => {
  console.log("Client connected:", req.socket.remoteAddress);

  // On connection, send history (candles + currentCandle)
  const history = candles.slice(-300); // last minutes
  if (currentCandle) history.push(currentCandle);
  ws.send(JSON.stringify({ type: "history", data: history }));

  // send initial orderbook & trades & price
  ws.send(JSON.stringify({ type: "orderBook", data: orderBook }));
  ws.send(JSON.stringify({ type: "trades", data: trades.slice(-50) }));
  ws.send(JSON.stringify({ type: "price", data: { price: lastPrice, change24h: 0 } }));

  ws.on("message", (msg) => {
    // client can subscribe etc.
    try {
      const m = JSON.parse(msg.toString());
      if (m.type === 'subscribe' && m.pair) {
        // nothing special for now
        ws.send(JSON.stringify({ type:'info', data:`subscribed to ${m.pair}` }));
      }
    } catch (e){}
  });

  ws.on("close", ()=>console.log("Client disconnected"));
});

server.listen(PORT, () => {
  console.log(`Price WS server listening on ${PORT}`);
  connectCoinbase();
});

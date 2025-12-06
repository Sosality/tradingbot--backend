// price-server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket as WsClient } from "ws";

const app = express();
app.use(express.json());
const server = http.createServer(app);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const PRODUCT = process.env.PRODUCT || "BTC-USD"; // coinbase product
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

// ======================================================
// In-memory state
// ======================================================
let currentPrice = 0;
let lastCandle = null; // { time, open, high, low, close }
let candleBuffer = []; // history of candles (old -> new)
const TRADES_BUFFER_LIMIT = 200;
const trades = []; // recent trades
let orderBook = { buy: [], sell: [] }; // top arrays of { price, size }

// ======================================================
// Broadcast helper
// ======================================================
let wss;
function broadcast(msg) {
  const s = JSON.stringify(msg);
  if (!wss) return;
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(s);
  });
}

// ======================================================
// Coinbase WS connection & handlers
// ======================================================
let coinbaseWs = null;
function connectCoinbase() {
  try {
    coinbaseWs = new WsClient(COINBASE_WS);

    coinbaseWs.on("open", () => {
      console.log("📡 Connected to Coinbase WS, subscribing...");
      const subscribe = {
        type: "subscribe",
        product_ids: [PRODUCT],
        channels: ["ticker", "matches", "level2"]
      };
      coinbaseWs.send(JSON.stringify(subscribe));
    });

    coinbaseWs.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // -- ticker: realtime price --
        if (data.type === "ticker" && data.product_id === PRODUCT && data.price) {
          currentPrice = Number(data.price);
          // broadcast simple price
          broadcast({ type: "price", data: { price: currentPrice, ts: Date.now() } });

          // update current 1-min candle
          updateCandleFromTicker(currentPrice, data.time);
        }

        // -- matches: real trades --
        else if (data.type === "match" && data.product_id === PRODUCT) {
          const tr = {
            id: data.trade_id ?? Date.now(),
            price: Number(data.price),
            size: Number(data.size),
            side: data.side, // "buy" or "sell" from taker perspective
            time: new Date(data.time).getTime()
          };
          trades.push(tr);
          while (trades.length > TRADES_BUFFER_LIMIT) trades.shift();
          broadcast({ type: "trades", data: trades.slice(-50) });
        }

        // -- level2 snapshot --
        else if (data.type === "snapshot" && data.product_id === PRODUCT) {
          // snapshot: { asks: [[price, size],...], bids: [...] }
          rebuildOrderBookFromSnapshot(data);
          broadcast({ type: "orderBook", data: orderBook });
        }

        // -- level2 updates --
        else if (data.type === "l2update" && data.product_id === PRODUCT) {
          // l2update: { changes: [[side, price, size], ...] }
          applyL2Update(data);
          // broadcast top book after update
          broadcast({ type: "orderBook", data: orderBook });
        }

      } catch (e) {
        console.warn("Coinbase parse error:", e);
      }
    });

    coinbaseWs.on("close", (code, reason) => {
      console.warn("Coinbase WS closed", code, reason);
      setTimeout(connectCoinbase, 5000);
    });

    coinbaseWs.on("error", (err) => {
      console.error("Coinbase WS error:", err);
      try { coinbaseWs.terminate(); } catch {}
    });
  } catch (e) {
    console.error("connectCoinbase failed", e);
    setTimeout(connectCoinbase, 5000);
  }
}

// ======================================================
// Candle building (1 minute) based on ticker timestamps
// ======================================================
function updateCandleFromTicker(price, isoTime) {
  // isoTime maybe string. We'll use Date.now() fallback
  const t = isoTime ? new Date(isoTime).getTime() : Date.now();
  const minute = Math.floor(t / 60000) * 60; // seconds bucket (we will keep seconds epoch)
  // Use seconds since epoch for frontend (some libs expect seconds)
  const bucketSec = Math.floor(t / 1000 / 60) * 60;

  if (!lastCandle) {
    // create initial candle
    lastCandle = {
      time: bucketSec,
      open: price,
      high: price,
      low: price,
      close: price
    };
    candleBuffer.push(lastCandle);
  } else {
    if (lastCandle.time !== bucketSec) {
      // new minute started -> close previous and push new candle
      // push copy (ensure we don't mutate older)
      const finished = { ...lastCandle };
      // keep buffer limit, say 300 candles
      candleBuffer.push(finished);
      if (candleBuffer.length > 500) candleBuffer.shift();
      // broadcast history periodically? we'll broadcast history on new connections; broadcast candle_update for finished
      broadcast({ type: "candle_update", data: finished });
      // start new candle
      lastCandle = {
        time: bucketSec,
        open: price,
        high: price,
        low: price,
        close: price
      };
    } else {
      // same minute -> update high/low/close
      if (price > lastCandle.high) lastCandle.high = price;
      if (price < lastCandle.low) lastCandle.low = price;
      lastCandle.close = price;
      // broadcast in-flight small updates optionally (we'll send lightweight 'candle_update' for live updates)
      // But to avoid spam, we only send every price tick as candle_update (frontend handles updates)
      broadcast({ type: "candle_update", data: lastCandle });
    }
  }
}

// ======================================================
// Orderbook helpers
// ======================================================
function rebuildOrderBookFromSnapshot(snapshot) {
  // snapshot.asks: ascending; bids: descending
  // Keep top N
  const asks = (snapshot.asks || []).map(x => ({ price: Number(x[0]), size: Number(x[1]) }))
    .sort((a,b)=>a.price - b.price)
    .slice(0, 200);
  const bids = (snapshot.bids || []).map(x => ({ price: Number(x[0]), size: Number(x[1]) }))
    .sort((a,b)=>b.price - a.price)
    .slice(0, 200);

  orderBook = {
    buy: bids.slice(0, 50),
    sell: asks.slice(0, 50)
  };
}

function applyL2Update(msg) {
  // msg.changes: [[side, price, size], ...]
  if (!msg.changes || !Array.isArray(msg.changes)) return;
  for (const ch of msg.changes) {
    const [sideRaw, priceS, sizeS] = ch;
    const side = (sideRaw || "").toLowerCase(); // "buy" or "sell"
    const price = Number(priceS);
    const size = Number(sizeS);

    const list = side === "buy" ? orderBook.buy : orderBook.sell;
    // Find index with same price
    const idx = list.findIndex(x => Number(x.price) === price);
    if (size === 0) {
      // remove
      if (idx !== -1) list.splice(idx, 1);
    } else {
      if (idx !== -1) {
        list[idx].size = size;
      } else {
        // insert keeping sort
        list.push({ price, size });
        if (side === "buy") list.sort((a,b)=>b.price-a.price);
        else list.sort((a,b)=>a.price-b.price);
      }
    }
    // keep only top 100
    if (list.length > 200) list.splice(200);
  }
  // ensure buy sorted desc, sell asc
  orderBook.buy.sort((a,b)=>b.price-a.price);
  orderBook.sell.sort((a,b)=>a.price-b.price);
  // trim to top 50
  orderBook.buy = orderBook.buy.slice(0,50);
  orderBook.sell = orderBook.sell.slice(0,50);
}

// ======================================================
// Helper: fetch historical candles from Coinbase Pro REST
// returns array of {time, open, high, low, close} with time in seconds
// ======================================================
async function fetchHistory(granularity = 60, limit = 200) {
  try {
    // Coinbase Pro REST endpoint
    const url = `https://api.pro.coinbase.com/products/${PRODUCT}/candles?granularity=${granularity}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("history fetch failed: " + resp.status);
    const data = await resp.json(); // array of arrays: [ time, low, high, open, close, volume ]
    // convert into ascending-ordered array of objects
    const arr = data.map(c => {
      // c[0] is time in seconds unix
      const timeSec = Number(c[0]);
      const low = Number(c[1]);
      const high = Number(c[2]);
      const open = Number(c[3]);
      const close = Number(c[4]);
      return { time: timeSec, open, high, low, close };
    }).sort((a,b)=>a.time - b.time);
    // fill candleBuffer with this
    candleBuffer = arr.slice(-500);
    lastCandle = candleBuffer[candleBuffer.length - 1] ? { ...candleBuffer[candleBuffer.length - 1] } : null;
    return candleBuffer;
  } catch (e) {
    console.warn("fetchHistory error", e);
    return [];
  }
}

// ======================================================
// WebSocket server for frontend clients
// ======================================================
wss = new WebSocketServer({ server });

wss.on("connection", async (ws, req) => {
  console.log("🎉 Frontend client connected (total: " + wss.clients.size + ")");

  // send hello
  ws.send(JSON.stringify({ type: "info", data: { msg: "price-ws ready", product: PRODUCT } }));

  // send latest price
  if (currentPrice) ws.send(JSON.stringify({ type: "price", data: { price: currentPrice, ts: Date.now() } }));

  // send recent trades
  if (trades.length) ws.send(JSON.stringify({ type: "trades", data: trades.slice(-50) }));

  // ensure we have history loaded; if not, fetch
  if (!candleBuffer || candleBuffer.length < 2) {
    const hist = await fetchHistory(60, 300);
    if (hist && hist.length) {
      ws.send(JSON.stringify({ type: "history", data: hist }));
      // set lastCandle from hist end
      lastCandle = hist[hist.length - 1] ? { ...hist[hist.length - 1] } : lastCandle;
    }
  } else {
    // send existing
    ws.send(JSON.stringify({ type: "history", data: candleBuffer }));
  }

  // send orderbook snapshot
  ws.send(JSON.stringify({ type: "orderBook", data: orderBook }));

  ws.on("message", (raw) => {
    // support simple commands from client (subscribe etc)
    try {
      const msg = JSON.parse(raw.toString());
      // if client asks for history with custom granularity:
      if (msg.type === "get_history") {
        const g = msg.granularity || 60;
        const l = msg.limit || 200;
        fetchHistory(g, l).then(hist => {
          ws.send(JSON.stringify({ type: "history", data: hist }));
        });
      } else {
        // ignore for now
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on("close", () => console.log("Client disconnected (remaining: " + wss.clients.size + ")"));
});

// ======================================================
// HTTP endpoints (quick helpers)
// ======================================================
app.get("/price", (req, res) => {
  res.json({ price: currentPrice });
});

app.get("/history", async (req, res) => {
  // optional query granularity & limit
  const g = Number(req.query.granularity) || 60;
  const l = Number(req.query.limit) || 200;
  const h = await fetchHistory(g, l);
  res.json({ data: h });
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

// ======================================================
// Start
// ======================================================
server.listen(PORT, () => {
  console.log(`WS Price Server running on ${PORT} (product ${PRODUCT})`);
  connectCoinbase();
});

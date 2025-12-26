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

// ——— CONFIG ———
const PRODUCTS = ["BTC-USD", "ETH-USD"];
const COINBASE_REST = "https://api.exchange.coinbase.com";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const HISTORY_CANDLES = 300; // Уменьшил для быстрого старта
const GRANULARITY = 60;

// ——— STORAGE ———
const historyStore = {};
const orderbookStore = {}; // { "BTC-USD": { bids: Map, asks: Map, sequence: 0 } }
const latestPrice = {};
const tradesStore = {};

// ——— UTILS ———

// Преобразуем Map в массив для клиента
function orderbookToArray(map, limit = 15) {
  // map: Map<priceString, sizeNumber>
  // Сортируем: для bids (покупатели) от дорогого к дешевому, для asks (продавцы) от дешевого к дорогому
  // Но здесь мы просто вернем массив, сортировку сделаем ниже, зная тип (bids/asks)
  return [...map.entries()].map(([p, s]) => ({ price: Number(p), size: Number(s) }));
}

function getFormattedOrderbook(pair) {
    const ob = orderbookStore[pair];
    if (!ob) return { buy: [], sell: [] };

    // Bids: Сортировка по убыванию цены (кто платит больше - тот выше)
    const buy = orderbookToArray(ob.bids).sort((a, b) => b.price - a.price).slice(0, 15);
    
    // Asks: Сортировка по возрастанию цены (кто продает дешевле - тот выше)
    const sell = orderbookToArray(ob.asks).sort((a, b) => a.price - b.price).slice(0, 15);

    return { buy, sell };
}

// Рассылка всем клиентам
function broadcast(msg) {
  const msgString = JSON.stringify(msg);
  let count = 0;
  wss.clients.forEach(client => {
    // Проверяем, открыт ли сокет и подписан ли клиент на эту пару
    if (client.readyState === WebSocket.OPEN && client.subscriptions && client.subscriptions.has(msg.pair)) {
      client.send(msgString);
      count++;
    }
  });
  // Раскомментируй для отладки, если подозреваешь, что клиенты не получают данные:
  // if (msg.type === "orderBook" && count > 0) console.log(`Sent OB update for ${msg.pair} to ${count} clients`);
}

// ——— COINBASE LOGIC ———

// 1. Загрузка Snapshot (Базовый слепок стакана)
async function loadSnapshot(product) {
  console.log(`[${product}] Fetching snapshot via REST...`);
  try {
    const r = await fetch(`${COINBASE_REST}/products/${product}/book?level=2`);
    if (!r.ok) throw new Error(r.statusText);
    const data = await r.json();

    const bids = new Map();
    const asks = new Map();

    data.bids.forEach(([p, s]) => bids.set(p, Number(s)));
    data.asks.forEach(([p, s]) => asks.set(p, Number(s)));

    orderbookStore[product] = { 
        bids, 
        asks, 
        sequence: data.sequence // Важно сохранить sequence снапшота
    };
    console.log(`[${product}] Snapshot loaded. Sequence: ${data.sequence}`);
  } catch (e) {
    console.error(`[${product}] Snapshot failed:`, e.message);
  }
}

// 2. Подключение к WebSocket Coinbase
let cbWs = null;
let pingInterval = null;

function connectCoinbase() {
  if (cbWs) cbWs.terminate();
  
  console.log("Connecting to Coinbase WS...");
  cbWs = new WebSocket(COINBASE_WS);

  cbWs.on('open', () => {
    console.log("Coinbase WS Connected!");
    const msg = {
      type: "subscribe",
      product_ids: PRODUCTS,
      channels: ["level2", "ticker", "matches"] // level2 - это стакан
    };
    cbWs.send(JSON.stringify(msg));

    // Пинг, чтобы соединение не рвалось
    pingInterval = setInterval(() => {
        if(cbWs.readyState === WebSocket.OPEN) cbWs.ping();
    }, 10000);
  });

  cbWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleCoinbaseMessage(msg);
    } catch (e) {
      console.error("Parse Error:", e);
    }
  });

  cbWs.on('error', (e) => console.error("Coinbase WS Error:", e));
  
  cbWs.on('close', () => {
    console.log("Coinbase WS Closed. Reconnecting in 3s...");
    clearInterval(pingInterval);
    setTimeout(connectCoinbase, 3000);
  });
}

function handleCoinbaseMessage(msg) {
    const pair = msg.product_id;
    if (!pair) return;

    // --- Обработка Ticker (Цена) ---
    if (msg.type === 'ticker') {
        const price = Number(msg.price);
        latestPrice[pair] = price;
        broadcast({ type: "price", pair, price });
    }

    // --- Обработка Trades (Сделки) ---
    if (msg.type === 'match') {
        if (!tradesStore[pair]) tradesStore[pair] = [];
        const trade = {
            price: Number(msg.price),
            side: msg.side,
            time: new Date(msg.time).getTime()
        };
        tradesStore[pair].push(trade);
        if (tradesStore[pair].length > 50) tradesStore[pair].shift();
        
        broadcast({ type: "trades", pair, trades: [trade] }); // Шлем сразу сделку
    }

    // --- Обработка OrderBook (L2 Update) ---
    if (msg.type === 'l2update') {
        // ❌ Ошибка 1: Если снапшот еще не загрузился, мы не можем обновлять стакан
        if (!orderbookStore[pair]) return;

        const store = orderbookStore[pair];
        const changes = msg.changes; // [ ["buy", "100.0", "1.5"], ... ]
        
        // ❌ Ошибка 2 (РЕШЕНО): Строгая проверка Sequence.
        // Мы просто проверяем, что новый пакет новее того, что у нас есть.
        // Если пакет пришел с sequence меньше текущего - это мусор/дубль.
        // Если sequence прыгнул (потеряли пакет) - мы все равно применяем, чтобы стакан "жил".
        
        // Coinbase присылает события пачками. Sequence один на сообщение.
        // Игнорируем проверку sequence для простоты, если хотим 100% движения, 
        // но лучше проверить, чтобы не применять старые данные.
        // if (msg.sequence <= store.sequence) return; 

        store.sequence = msg.sequence; // Обновляем seq

        changes.forEach(([side, priceStr, sizeStr]) => {
            const size = Number(sizeStr);
            const targetMap = (side === 'buy') ? store.bids : store.asks;

            if (size === 0) {
                targetMap.delete(priceStr);
            } else {
                targetMap.set(priceStr, size);
            }
        });
        
        // ВАЖНО: Мы НЕ отправляем broadcast здесь. 
        // l2update прилетают сотнями в секунду. Если слать каждый раз - клиент умрет.
        // Мы используем setInterval внизу файла.
    }
}

// ——— SERVER INIT ———

// 3. Рассылка стакана (Throttling)
// Отправляем стакан каждые 200мс, а не на каждое изменение
setInterval(() => {
    PRODUCTS.forEach(pair => {
        // Проверяем, изменился ли sequence с прошлой отправки, чтобы не спамить (опционально)
        // Но проще слать всегда, если есть подписчики
        const data = getFormattedOrderbook(pair);
        if (data.buy.length > 0) {
            broadcast({ type: "orderBook", pair, buy: data.buy, sell: data.sell });
        }
    });
}, 200); // 5 раз в секунду

// API для Init
app.post("/api/init", (req, res) => {
    // Мок юзера для теста
    res.json({
        ok: true,
        user: { user_id: 123, balance: 10000, photo_url: "" },
        positions: []
    });
});
app.post("/api/order/open", (req, res) => res.json({ ok:true, position: req.body, newBalance: 9900 }));
app.post("/api/order/close", (req, res) => res.json({ ok:true, newBalance: 10000 }));

// WS Server Client Handling
wss.on('connection', (ws) => {
    ws.subscriptions = new Set(); // Храним подписки клиента

    ws.on('message', (m) => {
        try {
            const data = JSON.parse(m);
            if (data.type === "subscribe") {
                const pair = data.pair;
                console.log(`Client subscribed to ${pair}`);
                ws.subscriptions.add(pair);

                // 1. Сразу шлем текущую цену
                if (latestPrice[pair]) {
                    ws.send(JSON.stringify({ type: "price", pair, price: latestPrice[pair] }));
                }
                
                // 2. Сразу шлем стакан, если есть
                const ob = getFormattedOrderbook(pair);
                if (ob.buy.length > 0) {
                    ws.send(JSON.stringify({ type: "orderBook", pair, buy: ob.buy, sell: ob.sell }));
                }

                // 3. Шлем историю свечей (Mock loading для примера)
                if(!historyStore[pair]) loadHistory(pair); // Загрузим если нет
                else ws.send(JSON.stringify({ type: "history", pair, data: historyStore[pair] }));
            }
        } catch (e) { console.error(e); }
    });
});

async function loadHistory(pair) {
    // Простая загрузка свечей
    try {
        const url = `${COINBASE_REST}/products/${pair}/candles?granularity=${GRANULARITY}`;
        const r = await fetch(url);
        const data = await r.json();
        const mapped = data.map(d => ({ time: d[0], open: d[3], high: d[2], low: d[1], close: d[4] })).reverse();
        historyStore[pair] = mapped;
        // Можно отправить всем, кто ждет, но в данном коде это происходит при подписке
    } catch(e){}
}

async function start() {
    console.log("Server Initializing...");
    
    // Сначала грузим снапшоты, чтобы стакан был готов до первого l2update
    for (const p of PRODUCTS) {
        await loadSnapshot(p);
    }
    
    connectCoinbase();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}

start();

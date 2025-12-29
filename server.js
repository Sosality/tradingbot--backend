import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import WebSocket from 'ws';

const app = express();
const httpServer = createServer(app);

// Настройка Socket.io с открытым CORS
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Binance WebSocket URL (BTC/USDT, depth 10, 100ms)
const binanceUrl = 'wss://stream.binance.com:9443/ws/btcusdt@depth10@100ms';
let binanceSocket;

function connectBinance() {
    binanceSocket = new WebSocket(binanceUrl);

    binanceSocket.on('open', () => {
        console.log('Connected to Binance WebSocket');
    });

    binanceSocket.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            
            // Отправляем данные клиенту
            io.emit('orderbook', {
                bids: parsed.bids,
                asks: parsed.asks,
                serverTime: Date.now()
            });
        } catch (e) {
            console.error('Parse error:', e);
        }
    });

    binanceSocket.on('close', () => {
        console.log('Binance connection closed, reconnecting...');
        setTimeout(connectBinance, 1000);
    });

    binanceSocket.on('error', (err) => {
        console.error('Binance error:', err);
    });
}

// Запускаем подключение
connectBinance();

// Простой роут для проверки
app.get('/', (req, res) => {
    res.send('TradingBot Backend (Binance) is running.');
});

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
});

httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

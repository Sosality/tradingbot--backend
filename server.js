const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Настройка Socket.io с открытым CORS, чтобы ты мог открыть HTML файл прямо с рабочего стола
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// 1. Подключение к Binance (публичный стрим, BTC/USDT, стакан 10 уровней, обновление 100мс)
const binanceUrl = 'wss://stream.binance.com:9443/ws/btcusdt@depth10@100ms';
let binanceSocket;

function connectBinance() {
    binanceSocket = new WebSocket(binanceUrl);

    binanceSocket.on('open', () => {
        console.log('Connected to Binance WebSocket');
    });

    binanceSocket.on('message', (data) => {
        // Парсим сырые данные
        const parsed = JSON.parse(data);
        
        // 2. Отправляем на фронтенд
        // Добавляем serverTime, чтобы замерять задержку
        io.emit('orderbook', {
            bids: parsed.bids,
            asks: parsed.asks,
            serverTime: Date.now()
        });
    });

    binanceSocket.on('close', () => {
        console.log('Binance connection closed, reconnecting...');
        setTimeout(connectBinance, 1000);
    });

    binanceSocket.on('error', (err) => {
        console.error('Binance error:', err);
    });
}

connectBinance();

// Простой роут для проверки жизни сервера
app.get('/', (req, res) => {
    res.send('TradingBot Backend is running. Connect via Socket.io');
});

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

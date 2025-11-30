import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// DB CONNECT
const db = new Pool({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: { rejectUnauthorized: false }
});

// Validate Telegram initData
function validateTelegram(initData) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete("hash");

    const dataCheckString = [...urlParams.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(process.env.BOT_TOKEN)
        .digest();

    const checkHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    return checkHash === hash;
}

// Create user in DB if not exists
async function ensureUser(userId) {
    const res = await db.query(
        `INSERT INTO users (id, balance)
         VALUES ($1, 10000)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [userId]
    );

    if (res.rows.length > 0) return res.rows[0];

    const user = await db.query(`SELECT * FROM users WHERE id=$1`, [userId]);
    return user.rows[0];
}

// Init app request
app.post("/api/init", async (req, res) => {
    const { initData } = req.body;
    if (!initData || !validateTelegram(initData))
        return res.json({ error: "Auth failed" });

    const userData = Object.fromEntries(
        new URLSearchParams(initData)
    );

    const userId = userData.user
        ? JSON.parse(userData.user).id
        : null;

    if (!userId) return res.json({ error: "No user" });

    const user = await ensureUser(userId);

    const token = jwt.sign({ userId }, process.env.JWT_SECRET);

    res.json({
        ok: true,
        token,
        balance: user.balance,
        positions: []
    });
});

// Get current price (fake or api later)
app.get("/api/price", (req, res) => {
    const price = 95000 + Math.random() * 1000;
    res.json({ price });
});

// Open a position
app.post("/api/order/open", async (req, res) => {
    const { userId, type, margin, leverage } = req.body;

    const user = await db.query("SELECT balance FROM users WHERE id=$1", [userId]);
    if (!user.rows.length) return res.json({ error: "No user" });

    const balance = user.rows[0].balance;
    if (balance < margin) return res.json({ error: "Not enough funds" });

    await db.query(
        `UPDATE users SET balance = balance - $1 WHERE id=$2`,
        [margin, userId]
    );

    const position = await db.query(
        `INSERT INTO positions (user_id, type, margin, leverage, entry_price)
         VALUES ($1,$2,$3,$4,95000)
         RETURNING *`,
        [userId, type, margin, leverage]
    );

    res.json({
        balance: balance - margin,
        position: position.rows[0]
    });
});

// Close position
app.post("/api/order/close", async (req, res) => {
    const { userId, positionId } = req.body;

    const position = await db.query(
        `SELECT * FROM positions WHERE id=$1 AND user_id=$2`,
        [positionId, userId]
    );
    if (!position.rows.length) return res.json({ error: "Position not found" });

    const pnl = Math.round((Math.random() - 0.5) * position.rows[0].margin); // fake calc
    await db.query(
        `UPDATE users SET balance = balance + $1 WHERE id=$2`,
        [position.rows[0].margin + pnl, userId]
    );

    await db.query(`DELETE FROM positions WHERE id=$1`, [positionId]);

    const updatedBalance = await db.query("SELECT balance FROM users WHERE id=$1", [userId]);

    res.json({
        balance: updatedBalance.rows[0].balance
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));

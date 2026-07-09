const express = require("express");
const router = express.Router();
const { promisePool: db } = require("../db");
const authMiddleware = require("../middleware/auth");

// Register (upsert) a device's public key for the authenticated user
router.post("/register", authMiddleware, async (req, res) => {
    const { deviceId, publicKey } = req.body;
    const userId = req.headers["x-current-user-id"];

    if (!deviceId || !publicKey || !userId) {
        return res.status(400).json({ success: false, error: "Missing required fields.", data: null });
    }

    try {
        await db.query(
            `INSERT INTO user_keys (user_id, device_id, public_key)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE public_key = VALUES(public_key)`,
            [userId, deviceId, publicKey]
        );
        return res.json({ success: true, error: null, data: "Device key registered." });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message, data: null });
    }
});

// Get all device public keys for a given user (used by sender to encrypt for all recipient devices)
router.get("/:userId", authMiddleware, async (req, res) => {
    const { userId } = req.params;

    try {
        const [rows] = await db.query(
            `SELECT device_id, public_key FROM user_keys WHERE user_id = ?`,
            [userId]
        );
        return res.json({ success: true, error: null, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message, data: null });
    }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const { promisePool: db } = require("../db");
const authMiddleware = require("../middleware/auth");

db.execute(`CREATE TABLE IF NOT EXISTS user_key_backups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  encrypted_private_key LONGTEXT NOT NULL,
  salt VARCHAR(64) NOT NULL,
  iv VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY user_backup (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`).catch(console.error);

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

// Store encrypted private key backup for the authenticated user
router.post('/backup', authMiddleware, async (req, res) => {
  const userId = req.headers['x-current-user-id'];
  const { deviceId, encryptedPrivateKey, salt, iv } = req.body;
  if (!deviceId || !encryptedPrivateKey || !salt || !iv) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }
  try {
    await db.execute(
      `INSERT INTO user_key_backups (user_id, device_id, encrypted_private_key, salt, iv)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE device_id=VALUES(device_id), encrypted_private_key=VALUES(encrypted_private_key), salt=VALUES(salt), iv=VALUES(iv), updated_at=NOW()`,
      [userId, deviceId, encryptedPrivateKey, salt, iv]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Retrieve encrypted private key backup for the authenticated user
router.get('/backup', authMiddleware, async (req, res) => {
  const userId = req.headers['x-current-user-id'];
  try {
    const [rows] = await db.execute(
      'SELECT device_id, encrypted_private_key, salt, iv FROM user_key_backups WHERE user_id = ?',
      [userId]
    );
    if (rows.length === 0) return res.json({ success: true, data: null });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
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

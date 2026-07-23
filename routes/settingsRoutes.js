const express = require("express");
const { promisePool: db } = require("../db");
const router = express.Router();

async function ensureBlockedTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS blocked_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            blocker_id INT NOT NULL,
            blocked_id INT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_block (blocker_id, blocked_id),
            INDEX (blocker_id),
            INDEX (blocked_id)
        )
    `);
}
ensureBlockedTable().catch(console.error);

router.patch("/update-account-privacy", async (req, res) => {
  try {
    const currentUserId = req.headers["x-current-user-id"];
    const { isPrivate } = req.body;

    const query = "UPDATE users SET is_private=? WHERE id=?";

    await db.query(query, [isPrivate, currentUserId]);

    return res.status(200).json({
      success: true,
      error: null,
      data: { message: "privacy updated successfully" },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      data: null,
    });
  }
});

router.post("/block/:userId", async (req, res) => {
    try {
        const blockerId = req.headers["x-current-user-id"];
        const blockedId = req.params.userId;

        if (!blockerId || !blockedId) {
            return res.status(400).json({ success: false, error: "Missing user IDs", data: null });
        }

        await db.query(
            "INSERT IGNORE INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)",
            [blockerId, blockedId]
        );

        return res.status(200).json({ success: true, error: null, data: { message: "User blocked" } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, data: null });
    }
});

router.delete("/block/:userId", async (req, res) => {
    try {
        const blockerId = req.headers["x-current-user-id"];
        const blockedId = req.params.userId;

        if (!blockerId || !blockedId) {
            return res.status(400).json({ success: false, error: "Missing user IDs", data: null });
        }

        await db.query(
            "DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?",
            [blockerId, blockedId]
        );

        return res.status(200).json({ success: true, error: null, data: { message: "User unblocked" } });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, data: null });
    }
});

router.get("/blocked", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];

        if (!currentUserId) {
            return res.status(400).json({ success: false, error: "Missing user ID", data: null });
        }

        const [rows] = await db.query(
            `SELECT u.id, u.username, u.profile_picture
             FROM blocked_users bu
             JOIN users u ON u.id = bu.blocked_id
             WHERE bu.blocker_id = ?
             ORDER BY bu.created_at DESC`,
            [currentUserId]
        );

        return res.status(200).json({ success: true, error: null, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message, data: null });
    }
});

module.exports = router;

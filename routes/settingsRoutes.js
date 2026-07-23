const express = require("express");
const { promisePool: db } = require("../db");
const bcrypt = require("bcrypt");
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

// ── Change Password ──────────────────────────────────────────────
router.post("/change-password", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: "All fields are required." });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: "New password must be at least 6 characters." });
        }

        const [[user]] = await db.query("SELECT password FROM users WHERE id = ?", [currentUserId]);
        if (!user) return res.status(404).json({ success: false, error: "User not found." });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(401).json({ success: false, error: "Current password is incorrect." });

        const hashed = await bcrypt.hash(newPassword, 10);
        await db.query("UPDATE users SET password = ? WHERE id = ?", [hashed, currentUserId]);

        return res.status(200).json({ success: true, data: { message: "Password updated successfully." } });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── Deactivate Account ───────────────────────────────────────────
router.post("/deactivate", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { password } = req.body;

        if (!password) return res.status(400).json({ success: false, error: "Password is required." });

        const [[user]] = await db.query("SELECT password FROM users WHERE id = ?", [currentUserId]);
        if (!user) return res.status(404).json({ success: false, error: "User not found." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, error: "Incorrect password." });

        await db.query("UPDATE users SET is_deactivated = 1, deactivated_at = NOW() WHERE id = ?", [currentUserId]);
        // Revoke all sessions so they're logged out everywhere
        await db.query("UPDATE user_sessions SET revoked = 1 WHERE user_id = ?", [currentUserId]);

        return res.status(200).json({ success: true, data: { message: "Account deactivated." } });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── Delete Account ───────────────────────────────────────────────
router.delete("/delete-account", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { password } = req.body;

        if (!password) return res.status(400).json({ success: false, error: "Password is required." });

        const [[user]] = await db.query("SELECT password FROM users WHERE id = ?", [currentUserId]);
        if (!user) return res.status(404).json({ success: false, error: "User not found." });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, error: "Incorrect password." });

        await db.query("DELETE FROM users WHERE id = ?", [currentUserId]);

        return res.status(200).json({ success: true, data: { message: "Account deleted." } });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

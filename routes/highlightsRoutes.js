const express = require("express");
const { promisePool: db } = require("../db");
const router = express.Router();

// Auto-create tables on startup
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS story_highlights (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                title VARCHAR(100) NOT NULL,
                cover_url TEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS highlight_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                highlight_id INT NOT NULL,
                media_url TEXT NOT NULL,
                media_type ENUM('image','video') DEFAULT 'image',
                order_index INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (highlight_id) REFERENCES story_highlights(id) ON DELETE CASCADE
            )
        `);
    } catch (e) { console.error("highlight tables check failed:", e); }
})();

// GET /api/highlights/:userId — all highlights with items
router.get("/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const [highlights] = await db.query(
            "SELECT id, title, cover_url, created_at FROM story_highlights WHERE user_id = ? ORDER BY created_at ASC",
            [userId]
        );
        if (highlights.length === 0) return res.json({ success: true, data: [] });

        const highlightIds = highlights.map(h => h.id);
        const [items] = await db.query(
            "SELECT id, highlight_id, media_url, media_type, order_index FROM highlight_items WHERE highlight_id IN (?) ORDER BY order_index ASC, created_at ASC",
            [highlightIds]
        );

        const itemsByHighlight = {};
        for (const item of items) {
            if (!itemsByHighlight[item.highlight_id]) itemsByHighlight[item.highlight_id] = [];
            itemsByHighlight[item.highlight_id].push(item);
        }

        const data = highlights.map(h => ({
            ...h,
            items: itemsByHighlight[h.id] || [],
        }));
        res.json({ success: true, data });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Failed to fetch highlights" });
    }
});

// POST /api/highlights — create highlight
router.post("/", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { title, cover_url, items } = req.body;
        if (!currentUserId || !title) return res.status(400).json({ success: false, error: "title required" });

        const [result] = await db.query(
            "INSERT INTO story_highlights (user_id, title, cover_url) VALUES (?, ?, ?)",
            [currentUserId, title.trim(), cover_url || null]
        );
        const highlightId = result.insertId;

        if (Array.isArray(items) && items.length > 0) {
            const rows = items.map((item, i) => [highlightId, item.media_url, item.media_type || "image", i]);
            await db.query("INSERT INTO highlight_items (highlight_id, media_url, media_type, order_index) VALUES ?", [rows]);
        }

        res.status(201).json({ success: true, highlightId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Failed to create highlight" });
    }
});

// PUT /api/highlights/:id — update title/cover and optionally replace all items
router.put("/:id", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { id } = req.params;
        const { title, cover_url, items } = req.body;
        if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });

        let query = "UPDATE story_highlights SET ";
        const values = [];
        if (title) { query += "title = ?, "; values.push(title.trim()); }
        if (cover_url !== undefined) { query += "cover_url = ?, "; values.push(cover_url || null); }

        if (values.length > 0) {
            query = query.slice(0, -2) + " WHERE id = ? AND user_id = ?";
            values.push(id, currentUserId);
            await db.query(query, values);
        }

        // Replace all items if provided
        if (Array.isArray(items)) {
            await db.query("DELETE FROM highlight_items WHERE highlight_id = ?", [id]);
            if (items.length > 0) {
                const rows = items.map((item, i) => [id, item.media_url, item.media_type || "image", i]);
                await db.query("INSERT INTO highlight_items (highlight_id, media_url, media_type, order_index) VALUES ?", [rows]);
            }
        }

        return res.json({ success: true });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: "Failed to update highlight" });
    }
});

// DELETE /api/highlights/:id
router.delete("/:id", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { id } = req.params;
        if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
        await db.query("DELETE FROM story_highlights WHERE id = ? AND user_id = ?", [id, currentUserId]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Failed to delete highlight" });
    }
});

// POST /api/highlights/:id/items — add items
router.post("/:id/items", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { id } = req.params;
        const { items } = req.body;
        if (!currentUserId || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: "items array required" });
        }
        const [[owner]] = await db.query("SELECT user_id FROM story_highlights WHERE id = ?", [id]);
        if (!owner || owner.user_id != currentUserId) return res.status(403).json({ success: false, error: "Forbidden" });

        const [[{ maxOrder }]] = await db.query("SELECT COALESCE(MAX(order_index),0) AS maxOrder FROM highlight_items WHERE highlight_id = ?", [id]);
        const rows = items.map((item, i) => [id, item.media_url, item.media_type || "image", maxOrder + i + 1]);
        await db.query("INSERT INTO highlight_items (highlight_id, media_url, media_type, order_index) VALUES ?", [rows]);
        res.status(201).json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Failed to add items" });
    }
});

// DELETE /api/highlights/:id/items/:itemId
router.delete("/:id/items/:itemId", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { id, itemId } = req.params;
        const [[owner]] = await db.query("SELECT user_id FROM story_highlights WHERE id = ?", [id]);
        if (!owner || owner.user_id != currentUserId) return res.status(403).json({ success: false, error: "Forbidden" });
        await db.query("DELETE FROM highlight_items WHERE id = ? AND highlight_id = ?", [itemId, id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Failed to remove item" });
    }
});

module.exports = router;

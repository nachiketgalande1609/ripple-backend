const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/search-users", (req, res) => {
    const { searchString } = req.query; // Extract search string from query parameters

    if (!searchString || searchString.trim().length === 0) {
        return res.status(400).json({
            success: false,
            error: "Search string is required.",
            data: null,
        });
    }

    const searchQuery = `
        SELECT id, username, email, profile_picture 
        FROM users 
        WHERE username LIKE ? 
        LIMIT 10`; // Limits to 10 results for performance

    // Use '%' on both sides for partial matching
    db.query(searchQuery, [`%${searchString}%`], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // If no results found
        if (results.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: {
                    message: "No users found.",
                    users: [],
                },
            });
        }

        res.status(200).json({
            success: true,
            error: null,
            data: {
                users: results,
            },
        });
    });
});

router.get("/fetch-search-history", (req, res) => {
    const { userId } = req.query;

    const query = `
    SELECT 
      sh.id AS history_id,
      sh.created_at,
      u.id AS id,
      u.username,
      u.email,
      u.profile_picture
    FROM search_history sh
    JOIN users u ON sh.target_user_id = u.id
    WHERE sh.user_id = ?
    ORDER BY sh.created_at DESC
    LIMIT 20`;

    db.query(query, [userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ data: results });
    });
});

// Add to search history when user is clicked
router.post("/update-search-history", (req, res) => {
    const { userId, target_user_id } = req.body;

    if (!target_user_id) {
        return res.status(400).json({ error: "Target user ID is required" });
    }

    // Delete old entry if exists
    db.query("DELETE FROM search_history WHERE user_id = ? AND target_user_id = ?", [userId, target_user_id], (deleteErr) => {
        if (deleteErr) return res.status(500).json({ error: deleteErr.message });

        // Insert the new entry
        db.query("INSERT INTO search_history (user_id, target_user_id) VALUES (?, ?)", [userId, target_user_id], (insertErr) => {
            if (insertErr) return res.status(500).json({ error: insertErr.message });
            res.json({ success: true });
        });
    });
});

router.delete("/delete-search-history", (req, res) => {
    const { userId, historyId } = req.query;

    const query = `
    DELETE FROM search_history 
    WHERE id = ? AND user_id = ?`;

    db.query(query, [historyId, userId], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ success: false });
        res.status(200).json({ success: true });
    });
});

module.exports = router;

const express = require("express");
const { promisePool: db } = require("../db");
const router = express.Router();

router.get("/search-users", async (req, res) => {
  try {
    const { searchString } = req.query;

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
      LIMIT 10
    `;

    const [results] = await db.query(searchQuery, [`%${searchString}%`]);

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

    return res.status(200).json({
      success: true,
      error: null,
      data: {
        users: results,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      data: null,
    });
  }
});

router.get("/fetch-search-history", async (req, res) => {
  try {
    const currentUserId = req.headers["x-current-user-id"];

    if (!currentUserId) {
      return res.status(400).json({ error: "Missing user id" });
    }

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
      LIMIT 20
    `;

    const [rows] = await db.query(query, [currentUserId]);

    return res.json({ data: rows });
  } catch (err) {
    console.error("Fetch search history error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Add to search history when user is clicked
router.post("/update-search-history", async (req, res) => {
  try {
    const { target_user_id } = req.body;
    const currentUserId = req.headers["x-current-user-id"];

    if (!target_user_id) {
      return res.status(400).json({
        success: false,
        error: "Target user ID is required",
        data: null,
      });
    }

    // Delete existing entry
    await db.query(
      "DELETE FROM search_history WHERE user_id = ? AND target_user_id = ?",
      [currentUserId, target_user_id],
    );

    // Insert new entry
    await db.query(
      "INSERT INTO search_history (user_id, target_user_id) VALUES (?, ?)",
      [currentUserId, target_user_id],
    );

    return res.json({
      success: true,
      error: null,
      data: null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      data: null,
    });
  }
});

router.delete("/delete-search-history", (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { historyId } = req.query;

  const query = `
    DELETE FROM search_history 
    WHERE id = ? AND user_id = ?`;

  db.query(query, [historyId, currentUserId], (err, result) => {
    if (err)
      return res.status(500).json({ success: false, error: err.message });
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false });
    res.status(200).json({ success: true });
  });
});

router.get("/search-hashtag", async (req, res) => {
  const { tag } = req.query;

  if (!tag || tag.trim().length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "tag is required.", data: null });
  }

  try {
    const [posts] = await db.query(
      `
      SELECT
          p.id,
          p.file_url
      FROM post_hashtags ph
      JOIN hashtags h ON ph.hashtag_id = h.id
      JOIN posts    p ON ph.post_id    = p.id
      WHERE h.tag = ?
      ORDER BY p.created_at DESC
      LIMIT 30
      `,
      [tag.toLowerCase().trim()],
    );

    return res
      .status(200)
      .json({ success: true, error: null, data: { posts } });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: err.message, data: null });
  }
});

// Fetch hashtag search history
router.get("/fetch-hashtag-search-history", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    if (!currentUserId) return res.status(400).json({ error: "Missing user id" });

    try {
        const [rows] = await db.query(
            `SELECT id AS history_id, tag, created_at
             FROM hashtag_search_history
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT 20`,
            [currentUserId]
        );
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Save hashtag to history (upsert — moves it to top if already exists)
router.post("/update-hashtag-search-history", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { tag } = req.body;

    if (!tag || !tag.trim()) {
        return res.status(400).json({ success: false, error: "tag is required." });
    }

    try {
        await db.query(
            `INSERT INTO hashtag_search_history (user_id, tag, created_at)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE created_at = NOW()`,
            [currentUserId, tag.toLowerCase().trim()]
        );
        return res.json({ success: true, error: null, data: null });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Delete single hashtag history entry
router.delete("/delete-hashtag-search-history", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { historyId } = req.query;

    try {
        const [result] = await db.query(
            `DELETE FROM hashtag_search_history WHERE id = ? AND user_id = ?`,
            [historyId, currentUserId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ success: false });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

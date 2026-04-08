const express = require("express");
const { promisePool: db } = require("../db");
const router = express.Router();

router.get("/fetch-notifications", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];

  if (!currentUserId) {
    return res.status(400).json({
      success: false,
      error: "Missing current user ID in headers",
      data: null,
    });
  }

  const query = `
        SELECT 
            n.id, n.type, n.message, n.post_id, n.created_at,
            u.id AS sender_id, u.username, u.profile_picture,
            p.file_url, fr.status AS request_status,
            fr.follower_id AS requester_id, fr.id AS request_id
        FROM notifications n
        JOIN users u ON n.sender_id = u.id
        LEFT JOIN posts p ON n.post_id = p.id
        LEFT JOIN follow_requests fr ON n.follow_request_id = fr.id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC
    `;

  try {
    const [notifications] = await db.query(query, [currentUserId]);

    // Update read status
    await db.query(
      "UPDATE notifications SET is_read = TRUE WHERE user_id = ?",
      [currentUserId],
    );

    res.status(200).json({
      success: true,
      error: null,
      data: notifications,
    });
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      data: null,
    });
  }
});

// Route to fetch unread notifications and messages count
router.get("/fetch-notifications-count", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];

  if (!currentUserId) {
    return res.status(400).json({
      success: false,
      error: "Missing current user ID in headers",
      data: null,
    });
  }

  const query = `
    SELECT 
        (SELECT COUNT(*) FROM notifications 
         WHERE user_id = ? AND is_read = FALSE
         AND sender_id NOT IN (
             SELECT muted_user_id FROM muted_users WHERE user_id = ?
         )
        ) AS unread_notifications,
        (SELECT COUNT(*) FROM messages 
         WHERE receiver_id = ? AND is_read = FALSE
         AND sender_id NOT IN (
             SELECT muted_user_id FROM muted_users WHERE user_id = ?
         )
        ) AS unread_messages;
`;

  try {
    const [results] = await db.query(query, [currentUserId, currentUserId, currentUserId, currentUserId]);

    res.status(200).json({
      success: true,
      error: null,
      data: {
        unread_notifications: results[0].unread_notifications,
        unread_messages: results[0].unread_messages,
      },
    });
  } catch (err) {
    console.error("Error fetching unread count:", err);
    res.status(500).json({
      success: false,
      error: err.message,
      data: null,
    });
  }
});

// Toggle mute for a user
router.post("/mute-user", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { muted_user_id } = req.body;

  if (!currentUserId || !muted_user_id) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields",
      data: null,
    });
  }

  try {
    const [existing] = await db.query(
      "SELECT id FROM muted_users WHERE user_id = ? AND muted_user_id = ?",
      [currentUserId, muted_user_id],
    );

    if (existing.length > 0) {
      // Already muted → unmute
      await db.query(
        "DELETE FROM muted_users WHERE user_id = ? AND muted_user_id = ?",
        [currentUserId, muted_user_id],
      );
      return res.json({ success: true, data: { muted: false }, error: null });
    } else {
      // Not muted → mute
      await db.query(
        "INSERT INTO muted_users (user_id, muted_user_id) VALUES (?, ?)",
        [currentUserId, muted_user_id],
      );
      return res.json({ success: true, data: { muted: true }, error: null });
    }
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: err.message, data: null });
  }
});

// Check if a user is muted
router.get("/mute-status", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { muted_user_id } = req.query;

  if (!currentUserId || !muted_user_id) {
    return res
      .status(400)
      .json({ success: false, error: "Missing fields", data: null });
  }

  try {
    const [rows] = await db.query(
      "SELECT id FROM muted_users WHERE user_id = ? AND muted_user_id = ?",
      [currentUserId, muted_user_id],
    );
    return res.json({
      success: true,
      data: { muted: rows.length > 0 },
      error: null,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: err.message, data: null });
  }
});

// GET /api/notifications/muted-users — returns all muted user IDs for the current user
router.get("/muted-users", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    if (!currentUserId) {
        return res.status(400).json({ success: false, error: "Missing user ID", data: null });
    }
    try {
        const [rows] = await db.query(
            "SELECT muted_user_id FROM muted_users WHERE user_id = ?",
            [currentUserId]
        );
        return res.json({
            success: true,
            data: rows.map((r) => r.muted_user_id),
            error: null,
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message, data: null });
    }
});

module.exports = router;

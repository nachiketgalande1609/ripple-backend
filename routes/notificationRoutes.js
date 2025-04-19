const express = require("express");
const db = require("../db");
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
        const [notifications] = await db.promise().query(query, [currentUserId]);

        // Update read status
        await db.promise().query("UPDATE notifications SET is_read = TRUE WHERE user_id = ?", [currentUserId]);

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
            (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = FALSE) AS unread_notifications,
            (SELECT COUNT(*) FROM messages WHERE receiver_id = ? AND is_read = FALSE) AS unread_messages;
    `;

    try {
        const [results] = await db.promise().query(query, [currentUserId, currentUserId]);

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

module.exports = router;

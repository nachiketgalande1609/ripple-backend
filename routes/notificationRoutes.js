const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/fetch-notifications", (req, res) => {
    const { userId } = req.query;

    const query = `
        SELECT n.id, n.type, n.message, n.post_id, n.created_at,
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

    db.query(query, [userId], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // Update read status
        db.query("UPDATE notifications SET is_read = TRUE WHERE user_id = ?", [userId], (updateErr) => {
            if (updateErr) {
                return res.status(500).json({
                    success: false,
                    error: updateErr.message,
                    data: null,
                });
            }

            res.status(200).json({
                success: true,
                error: null,
                data: results,
            });
        });
    });
});

// Route to fetch unread notifications and messages count
router.get("/fetch-notifications-count", (req, res) => {
    const { userId } = req.query;

    const query = `
        SELECT 
            (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = FALSE) AS unread_notifications,
            (SELECT COUNT(*) FROM messages WHERE receiver_id = ? AND is_read = FALSE) AS unread_messages;
    `;

    db.query(query, [userId, userId], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        res.status(200).json({
            success: true,
            error: null,
            data: {
                unread_notifications: results[0].unread_notifications,
                unread_messages: results[0].unread_messages,
            },
        });
    });
});

module.exports = router;

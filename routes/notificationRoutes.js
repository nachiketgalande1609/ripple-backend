const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/:userId", (req, res) => {
    const { userId } = req.params;

    const query = `
        SELECT n.id, n.type, n.message, n.post_id, n.created_at, 
               u.id AS sender_id, u.username, u.profile_picture,
               (SELECT COUNT(*) FROM followers f 
                WHERE f.follower_id = ? AND f.following_id = n.sender_id) AS is_following,
               p.image_url
        FROM notifications n
        JOIN users u ON n.sender_id = u.id
        LEFT JOIN posts p ON n.post_id = p.id AND (n.type = 'like' OR n.type = 'comment')
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC;
    `;

    db.query(query, [userId, userId], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // Modify the result to add follow status for each notification if it's a follow request
        const updatedResults = results.map((notification) => {
            // If the notification type is 'follow_request', add the follow status
            if (notification.type === "follow_request") {
                notification.is_following = notification.is_following > 0;
            }
            return notification;
        });

        res.status(200).json({
            success: true,
            error: null,
            data: updatedResults,
        });
    });
});

module.exports = router;

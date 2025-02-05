const express = require("express");
const router = express.Router();
const db = require("../db");

// Get all messages and users for the current user
router.get("/:currentUserId", (req, res) => {
    const { currentUserId } = req.params;

    // Fetch users the current user has messaged with, excluding the current user
    db.query(
        `
        SELECT DISTINCT u.id, u.username, u.profile_picture 
        FROM users u
        JOIN messages m ON u.id = m.sender_id OR u.id = m.receiver_id
        WHERE (m.sender_id = ? OR m.receiver_id = ?) AND u.id != ?
        ORDER BY u.username;
    `,
        [currentUserId, currentUserId, currentUserId],
        (usersErr, usersResults) => {
            if (usersErr) {
                return res.status(500).json({
                    success: false,
                    error: usersErr.message,
                    data: null,
                });
            }

            // Fetch all messages where the user is either sender or receiver
            db.query(
                `
            SELECT sender_id, receiver_id, message_text, timestamp 
            FROM messages 
            WHERE sender_id = ? OR receiver_id = ?
            ORDER BY timestamp ASC;
        `,
                [currentUserId, currentUserId],
                (messagesErr, messagesResults) => {
                    if (messagesErr) {
                        return res.status(500).json({
                            success: false,
                            error: messagesErr.message,
                            data: null,
                        });
                    }

                    // Organize messages by user
                    const groupedMessages = {};
                    messagesResults.forEach((msg) => {
                        const chatPartnerId = msg.sender_id === parseInt(currentUserId) ? msg.receiver_id : msg.sender_id;

                        if (!groupedMessages[chatPartnerId]) {
                            groupedMessages[chatPartnerId] = [];
                        }

                        groupedMessages[chatPartnerId].push({
                            sender_id: msg.sender_id,
                            message_text: msg.message_text,
                            timestamp: msg.timestamp,
                        });
                    });

                    res.json({
                        success: true,
                        data: { users: usersResults, messages: groupedMessages },
                        error: null,
                    });
                }
            );
        }
    );
});

module.exports = router;

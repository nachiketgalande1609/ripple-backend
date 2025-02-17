const express = require("express");
const db = require("../db");
const router = express.Router();
const { emitUnreadNotificationCount, emitNotifications } = require("../utils/utils");

// Follow user
router.post("/", async (req, res) => {
    const { followerId, followingId } = req.body;

    if (!followerId || !followingId) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields",
            data: null,
        });
    }

    try {
        // Check for existing follow request
        const [existing] = await db.promise().query(
            `SELECT * FROM follow_requests 
             WHERE follower_id = ? AND following_id = ? AND status = 'pending'`,
            [followerId, followingId]
        );

        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                error: "Follow request already exists",
                data: null,
            });
        }

        // Create new follow request
        const [result] = await db.promise().query(
            `INSERT INTO follow_requests (follower_id, following_id) 
             VALUES (?, ?)`,
            [followerId, followingId]
        );

        // Create notification
        await db.promise().query(
            `INSERT INTO notifications 
             (user_id, sender_id, type, message, follow_request_id, created_at)
             VALUES (?, ?, 'follow_request', ?, ?, NOW())`,
            [followingId, followerId, "has sent you a follow request.", result.insertId]
        );

        emitUnreadNotificationCount(followingId);

        res.status(201).json({
            success: true,
            error: null,
            data: { followRequestId: result.insertId, message: "Follow request sent" },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

// Respond to follow request
router.post("/response", async (req, res) => {
    const { requestId, status } = req.body;

    if (!requestId || !status) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields",
            data: null,
        });
    }

    try {
        // Check if follow request exists
        const [request] = await db.promise().query(`SELECT * FROM follow_requests WHERE id = ?`, [requestId]);

        if (request.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Follow request not found",
                data: null,
            });
        }

        const { follower_id, following_id } = request[0];

        // Update follow request status
        await db.promise().query(`UPDATE follow_requests SET status = ? WHERE id = ?`, [status, requestId]);

        // If accepted, create a follower relationship
        if (status === "accepted") {
            await db.promise().query(`INSERT INTO followers (follower_id, following_id) VALUES (?, ?)`, [follower_id, following_id]);

            // Create acceptance notification
            await db.promise().query(
                `INSERT INTO notifications (user_id, sender_id, type, message, created_at)
                 VALUES (?, ?, 'follow_accepted', ?, NOW())`,
                [follower_id, following_id, "accepted your follow request."]
            );
        }

        res.status(200).json({
            success: true,
            error: null,
            data: { requestId, status, message: `Request ${status}` },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

router.get("/following/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        const query = `
            SELECT u.id, u.username, u.profile_picture
            FROM followers f
            JOIN users u ON f.following_id = u.id
            WHERE f.follower_id = ?
        `;

        const [results] = await db.promise().query(query, [userId]);

        res.status(200).json({
            success: true,
            data: results,
        });
    } catch (error) {
        console.error("Error fetching following users:", error.message);
        res.status(500).json({
            success: false,
            error: "Internal server error",
        });
    }
});

module.exports = router;

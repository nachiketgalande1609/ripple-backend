const express = require("express");
const { promisePool: db } = require("../db");
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
        const [existing] = await db.query(
            `SELECT * FROM follow_requests 
             WHERE follower_id = ? AND following_id = ? AND status = 'pending'`,
            [followerId, followingId],
        );

        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                error: "Follow request already exists",
                data: null,
            });
        }

        // Create new follow request
        const [result] = await db.query(
            `INSERT INTO follow_requests (follower_id, following_id) 
             VALUES (?, ?)`,
            [followerId, followingId],
        );

        // Create notification
        await db.query(
            `INSERT INTO notifications 
             (user_id, sender_id, type, message, follow_request_id, created_at)
             VALUES (?, ?, 'follow_request', ?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))`,
            [followingId, followerId, "has sent you a follow request.", result.insertId],
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

router.delete("/unfollow", async (req, res) => {
    const { followerId, followingId } = req.body;

    if (!followerId || !followingId) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields",
            data: null,
        });
    }

    try {
        // Delete the follow relationship from the followers table
        const [result] = await db.query(
            `DELETE FROM followers 
             WHERE follower_id = ? AND following_id = ?`,
            [followerId, followingId],
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "Follow relationship not found",
                data: null,
            });
        }

        res.status(200).json({
            success: true,
            error: null,
            data: { message: "Unfollowed successfully" },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

router.delete("/remove-follower", async (req, res) => {
    const { followerId, followingId } = req.body;
    // followerId = the person you want to remove
    // followingId = you (the current user)

    if (!followerId || !followingId) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields",
            data: null,
        });
    }

    try {
        const [result] = await db.query(
            `DELETE FROM followers 
             WHERE follower_id = ? AND following_id = ?`,
            [followerId, followingId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "Follow relationship not found",
                data: null,
            });
        }

        res.status(200).json({
            success: true,
            error: null,
            data: { message: "Follower removed successfully" },
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
        const [request] = await db.query(`SELECT * FROM follow_requests WHERE id = ?`, [requestId]);

        if (request.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Follow request not found",
                data: null,
            });
        }

        const { follower_id, following_id } = request[0];

        // Update follow request status
        await db.query(`UPDATE follow_requests SET status = ? WHERE id = ?`, [status, requestId]);

        // If accepted, create a follower relationship
        if (status === "accepted") {
            await db.query(`INSERT INTO followers (follower_id, following_id) VALUES (?, ?)`, [follower_id, following_id]);

            // Create acceptance notification
            await db.query(
                `INSERT INTO notifications (user_id, sender_id, type, message, created_at)
                 VALUES (?, ?, 'follow_accepted', ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))`,
                [follower_id, following_id, "accepted your follow request."],
            );

            emitUnreadNotificationCount(follower_id);
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

router.get("/fetch-following-list", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];

        const query = `
            SELECT u.id, u.username, u.profile_picture
            FROM followers f
            JOIN users u ON f.following_id = u.id
            WHERE f.follower_id = ?
        `;

        const [results] = await db.query(query, [currentUserId]);

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

// Cancel follow request
router.delete("/cancel-request", async (req, res) => {
    const { followerId, followingId } = req.body;

    if (!followerId || !followingId) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields",
            data: null,
        });
    }

    try {
        // Delete the pending follow request
        const [result] = await db.query(
            `DELETE FROM follow_requests 
             WHERE follower_id = ? AND following_id = ? AND status = 'pending'`,
            [followerId, followingId],
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "No pending follow request found",
                data: null,
            });
        }

        // Optionally delete the related notification
        await db.query(
            `DELETE FROM notifications 
             WHERE sender_id = ? AND user_id = ? AND type = 'follow_request'`,
            [followerId, followingId],
        );

        res.status(200).json({
            success: true,
            error: null,
            data: { message: "Follow request canceled" },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

router.get("/:userId/followers", async (req, res) => {
    try {
        const { userId } = req.params;
        const currentUserId = req.headers["x-current-user-id"];
 
        // Get the target user's username for display
        const [userRows] = await db.query(
            "SELECT username FROM users WHERE id = ?",
            [userId]
        );
 
        if (userRows.length === 0) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
 
        // Fetch followers with their follow-back status relative to currentUserId
        const [followers] = await db.query(
            `SELECT
                u.id,
                u.username,
                u.profile_picture,
                u.is_private,
                CASE WHEN f2.follower_id IS NOT NULL THEN 1 ELSE 0 END AS is_following,
                COALESCE(fr.status, 'none') AS follow_status,
                CASE WHEN fr.status = 'pending' THEN 1 ELSE 0 END AS is_request_active
             FROM followers f
             JOIN users u ON f.follower_id = u.id
             LEFT JOIN followers f2
                ON f2.follower_id = ? AND f2.following_id = u.id
             LEFT JOIN follow_requests fr
                ON fr.follower_id = ? AND fr.following_id = u.id AND fr.status = 'pending'
             WHERE f.following_id = ?
             ORDER BY u.username ASC`,
            [currentUserId, currentUserId, userId]
        );
 
        res.status(200).json({
            success: true,
            data: {
                username: userRows[0].username,
                followers: followers.map((row) => ({
                    ...row,
                    is_following: !!row.is_following,
                    is_request_active: !!row.is_request_active,
                })),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get("/:userId/following", async (req, res) => {
    try {
        const { userId } = req.params;
        const currentUserId = req.headers["x-current-user-id"];
 
        // Get the target user's username for display
        const [userRows] = await db.query(
            "SELECT username FROM users WHERE id = ?",
            [userId]
        );
 
        if (userRows.length === 0) {
            return res.status(404).json({ success: false, error: "User not found" });
        }
 
        // Fetch following list with current viewer's follow status for each
        const [following] = await db.query(
            `SELECT
                u.id,
                u.username,
                u.profile_picture,
                u.is_private,
                CASE WHEN f2.follower_id IS NOT NULL THEN 1 ELSE 0 END AS is_following,
                COALESCE(fr.status, 'none') AS follow_status,
                CASE WHEN fr.status = 'pending' THEN 1 ELSE 0 END AS is_request_active
             FROM followers f
             JOIN users u ON f.following_id = u.id
             LEFT JOIN followers f2
                ON f2.follower_id = ? AND f2.following_id = u.id
             LEFT JOIN follow_requests fr
                ON fr.follower_id = ? AND fr.following_id = u.id AND fr.status = 'pending'
             WHERE f.follower_id = ?
             ORDER BY u.username ASC`,
            [currentUserId, currentUserId, userId]
        );
 
        res.status(200).json({
            success: true,
            data: {
                username: userRows[0].username,
                following: following.map((row) => ({
                    ...row,
                    is_following: !!row.is_following,
                    is_request_active: !!row.is_request_active,
                })),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

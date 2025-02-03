const express = require("express");
const db = require("../db");
const router = express.Router();

// Follow user
router.post("/", async (req, res) => {
    const { followerId, followingId } = req.body;

    // Input validation
    if (!followerId || !followingId) {
        return res.status(400).json({
            success: false,
            error: "Follower and following user IDs are required.",
            data: null,
        });
    }

    if (followerId === followingId) {
        return res.status(400).json({
            success: false,
            error: "You cannot follow yourself.",
            data: null,
        });
    }

    // Check if the follow request already exists
    const checkFollowRequestQuery = "SELECT * FROM followers WHERE follower_id = ? AND following_id = ? AND status='pending'";
    db.query(checkFollowRequestQuery, [followerId, followingId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            return res.status(400).json({
                success: false,
                error: "You have already sent a follow request to this user.",
                data: null,
            });
        }

        // Insert the follow request into the followers table
        const insertFollowRequestQuery = "INSERT INTO followers (follower_id, following_id) VALUES (?, ?)";
        db.query(insertFollowRequestQuery, [followerId, followingId], (err, followResult) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            const followRequestId = followResult.insertId;

            // Create a notification for the follow request
            const notificationMessage = `has sent you a follow request.`;
            const insertNotificationQuery = `
                INSERT INTO notifications (user_id, sender_id, type, message, follow_request_id, created_at)
                VALUES (?, ?, 'follow_request', ?, ?, NOW());
            `;

            db.query(insertNotificationQuery, [followingId, followerId, notificationMessage, followRequestId], (err, result) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Success response
                res.status(201).json({
                    success: true,
                    error: null,
                    data: {
                        message: `User ${followerId} sent a follow request to user ${followingId}`,
                        notification: {
                            id: result.insertId,
                            message: notificationMessage,
                        },
                    },
                });
            });
        });
    });
});

router.post("/response", async (req, res) => {
    const { followerId, currentUserId, status } = req.body;

    console.log(followerId, currentUserId, status);

    // Input validation
    if (!followerId || !currentUserId || !status) {
        return res.status(400).json({
            success: false,
            error: "Follower ID, following ID, and status are required.",
            data: null,
        });
    }

    if (status !== "accepted" && status !== "rejected") {
        return res.status(400).json({
            success: false,
            error: "Invalid status. It must be 'accepted' or 'rejected'.",
            data: null,
        });
    }

    // Check if a follow request exists
    const checkFollowRequestQuery = "SELECT * FROM followers WHERE follower_id = ? AND following_id = ?";
    db.query(checkFollowRequestQuery, [followerId, currentUserId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                error: "No follow request found.",
                data: null,
            });
        }

        // Update the follow request status
        const updateFollowRequestQuery = "UPDATE followers SET status = ? WHERE follower_id = ? AND following_id = ?";
        db.query(updateFollowRequestQuery, [status, followerId, currentUserId], (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            if (status === "accepted") {
                const notificationMessage = `accepted your follow request.`;
                const insertNotificationQuery = `
                    INSERT INTO notifications (user_id, sender_id, type, message, created_at)
                    VALUES (?, ?, 'follow_accepted', ?, NOW());
                `;

                db.query(insertNotificationQuery, [followerId, currentUserId, notificationMessage], (err, result) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    res.status(200).json({
                        success: true,
                        message: "Follow request accepted.",
                    });
                });
            } else {
                // Send notification for follow request rejection
                const notificationMessage = `rejected your follow request.`;
                const insertNotificationQuery = `
                    INSERT INTO notifications (user_id, sender_id, type, message, created_at)
                    VALUES (?, ?, 'follow_rejected', ?, NOW());
                `;

                db.query(insertNotificationQuery, [followerId, currentUserId, notificationMessage], (err, result) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    res.status(200).json({
                        success: true,
                        message: "Follow request rejected.",
                    });
                });
            }
        });
    });
});

module.exports = router;

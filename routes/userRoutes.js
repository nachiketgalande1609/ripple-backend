const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/profile/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const { currentUserId } = req.query;

        // Fetch user profile
        const userQuery = "SELECT id, username, email, bio, profile_picture FROM users WHERE id = ?";
        const [userResults] = await db.promise().query(userQuery, [userId]);

        if (userResults.length === 0) {
            return res.status(404).json({ success: false, error: "User not found", data: null });
        }

        const user = userResults[0];

        // Execute all queries concurrently
        const [[postResults], [followersResults], [followingResults], [followRequestResults], [followResults]] = await Promise.all([
            db.promise().query("SELECT COUNT(id) AS posts_count FROM posts WHERE user_id = ?", [userId]),
            db.promise().query("SELECT COUNT(*) AS followers_count FROM followers WHERE following_id = ?", [userId]),
            db.promise().query("SELECT COUNT(*) AS following_count FROM followers WHERE follower_id = ?", [userId]),
            db.promise().query(
                `
                SELECT status 
                FROM follow_requests 
                WHERE follower_id = ? AND following_id = ? 
                ORDER BY created_at DESC LIMIT 1`,
                [currentUserId, userId]
            ),
            db.promise().query(
                `
                SELECT 1 FROM followers 
                WHERE follower_id = ? AND following_id = ? LIMIT 1`,
                [currentUserId, userId]
            ),
        ]);

        // Extract values
        const postsCount = postResults[0]?.posts_count || 0;
        const followersCount = followersResults[0]?.followers_count || 0;
        const followingCount = followingResults[0]?.following_count || 0;

        // Determine follow status
        let followStatus = "none";
        if (followRequestResults.length > 0) {
            followStatus = followRequestResults[0].status;
        }

        const isFollowing = followResults.length > 0;

        res.status(200).json({
            success: true,
            data: {
                ...user,
                posts_count: postsCount,
                followers_count: followersCount,
                following_count: followingCount,
                is_following: isFollowing,
                is_request_active: followStatus === "pending",
                follow_status: followStatus,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get("/chat/:userId", (req, res) => {
    const { userId } = req.params;

    const userQuery = "SELECT id, username, profile_picture FROM users WHERE id = ?";

    db.query(userQuery, [userId], (err, userResults) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (userResults.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = userResults[0];

        res.status(200).json({
            success: true,
            error: null,
            data: {
                id: user.id,
                username: user.username,
                profile_picture: user.profile_picture,
            },
        });
    });
});

module.exports = router;

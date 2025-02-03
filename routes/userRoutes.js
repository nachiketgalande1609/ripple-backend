const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/profile/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const { currentUserId } = req.query; // Assuming current user ID is passed in query params

        // Fetch user profile
        const userQuery = "SELECT id, username, email, bio, profile_picture FROM users WHERE id = ?";
        const [userResults] = await db.promise().query(userQuery, [userId]);

        if (userResults.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = userResults[0];

        // Execute all queries concurrently
        const [[postResults], [followersResults], [followingResults], [followRequestResults], [followResults]] = await Promise.all([
            db.promise().query("SELECT COUNT(id) AS posts_count FROM posts WHERE user_id = ?", [userId]),
            db.promise().query("SELECT COUNT(*) AS followers_count FROM followers WHERE following_id = ?", [userId]),
            db.promise().query("SELECT COUNT(*) AS following_count FROM followers WHERE follower_id = ?", [userId]),
            db
                .promise()
                .query("SELECT status FROM followers WHERE follower_id = ? AND following_id = ? ORDER BY created_at DESC LIMIT 1", [
                    currentUserId,
                    userId,
                ]),
            db.promise().query("SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ? LIMIT 1", [currentUserId, userId]),
        ]);

        // Extract values
        const postsCount = postResults.length > 0 ? postResults[0].posts_count : 0;
        const followersCount = followersResults.length > 0 ? followersResults[0].followers_count : 0;
        const followingCount = followingResults.length > 0 ? followingResults[0].following_count : 0;

        // Determine follow status
        let followStatus = "none";
        if (followRequestResults.length > 0) {
            const status = followRequestResults[0].status;
            followStatus = ["pending", "accepted", "rejected"].includes(status) ? status : "none";
        }

        const isFollowing = followResults.length > 0;

        res.status(200).json({
            success: true,
            error: null,
            data: {
                id: user.id,
                username: user.username,
                email: user.email,
                bio: user.bio,
                profile_picture: user.profile_picture,
                posts_count: postsCount,
                followers_count: followersCount,
                following_count: followingCount,
                is_following: isFollowing,
                is_request_active: followStatus === "pending",
                follow_status: followStatus,
            },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

router.get("/search", (req, res) => {
    const { searchString } = req.query; // Extract search string from query parameters

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
        LIMIT 10`; // Limits to 10 results for performance

    // Use '%' on both sides for partial matching
    db.query(searchQuery, [`%${searchString}%`], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // If no results found
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

        res.status(200).json({
            success: true,
            error: null,
            data: {
                users: results,
            },
        });
    });
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

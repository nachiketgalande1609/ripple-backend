const express = require("express");
const db = require("../db");
const router = express.Router();
const { getTimeAgo } = require("../utils/utils");

router.get("/", (req, res) => {
    const query = "SELECT u.username, u.profile_picture, p.* FROM posts p INNER JOIN users u ON p.user_id=u.id ORDER BY created_at DESC;";

    db.query(query, (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        result.forEach((post) => {
            const createdAt = new Date(post.created_at);
            post.timeAgo = getTimeAgo(createdAt);
        });

        res.status(200).json({
            success: true,
            error: null,
            data: result,
        });
    });
});

router.post("/", (req, res) => {
    const { content, image_url, video_url, location, user_id } = req.body;

    if (!content || !image_url) {
        return res.status(400).json({
            success: false,
            error: "content and image url are required.",
            data: null,
        });
    }

    const query = "INSERT INTO posts (content, image_url, video_url, location, user_id) VALUES (?, ?, ?, ?, ?)";

    db.query(query, [content, image_url, video_url, location, user_id], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        res.status(201).json({
            success: true,
            error: null,
            message: "Post created successfully",
            postId: result.insertId,
        });
    });
});

module.exports = router;

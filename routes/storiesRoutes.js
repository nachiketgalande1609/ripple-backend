const express = require("express");
const db = require("../db");
const router = express.Router();
const { getTimeAgo } = require("../utils/utils");
const { createNotification } = require("../utils/utils");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { emitUnreadNotificationCount, emitNotifications } = require("../utils/utils");
const sharp = require("sharp");

const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

router.get("/", async (req, res) => {
    const { userId } = req.query; // Corrected from req.params to req.query

    if (!userId) {
        return res.status(400).json({
            success: false,
            error: "User ID is required.",
            data: null,
        });
    }

    try {
        const query = `
            SELECT 
                s.id AS story_id, s.caption, s.media_url, s.media_type, 
                s.media_width, s.media_height, s.created_at, 
                u.id AS user_id, u.username, u.profile_picture,
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'view_id', v.id,
                        'viewer_id', v.user_id,
                        'viewer_username', viewer.username,
                        'viewed_at', v.viewed_at
                    )
                ) AS viewers
            FROM stories s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN followers f ON s.user_id = f.following_id
            LEFT JOIN story_views v ON s.id = v.story_id  -- Join with story_views table
            LEFT JOIN users viewer ON v.user_id = viewer.id  -- Get the viewer's username
            WHERE (f.follower_id = ? OR s.user_id = ?)  -- Added check for user's own stories
              AND s.is_active = 1
              AND (s.expires_at IS NULL OR s.expires_at > NOW())
            GROUP BY s.id, u.id  -- Group by story and user to get all viewers for each story
            ORDER BY s.created_at DESC
        `;

        db.query(query, [userId, userId], (err, results) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            // Ensure viewers are parsed properly
            results.forEach((story) => {
                if (story.viewers && typeof story.viewers === "string") {
                    story.viewers = JSON.parse(story.viewers); // Only parse if it's a string
                }
            });

            return res.status(200).json({
                success: true,
                stories: results,
            });
        });
    } catch (error) {
        console.error("Error fetching stories:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch stories.",
            data: null,
        });
    }
});

router.post("/upload", upload.single("media"), async (req, res) => {
    const { caption, user_id } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({
            success: false,
            error: "Media file is required.",
            data: null,
        });
    }

    const fileName = file.originalname;
    const fileType = file.mimetype;
    let mediaWidth = null;
    let mediaHeight = null;
    let mediaType = fileType.startsWith("image/") ? "image" : "video";

    // Extract image dimensions only if it's an image
    if (mediaType === "image") {
        try {
            const metadata = await sharp(file.buffer).metadata();
            mediaWidth = metadata.width;
            mediaHeight = metadata.height;
        } catch (err) {
            console.error("Error processing image:", err);
            return res.status(500).json({
                success: false,
                error: "Failed to process image.",
                data: null,
            });
        }
    }

    const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: `stories/${Date.now()}_${fileName}`,
        Body: file.buffer,
        ContentType: fileType,
        ACL: "public-read",
    };

    try {
        const command = new PutObjectCommand(uploadParams);
        await s3.send(command);

        const mediaUrl = `https://${uploadParams.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadParams.Key}`;

        // Insert story into the database
        const query = `
            INSERT INTO stories (caption, media_url, media_type, user_id, media_width, media_height)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        db.query(query, [caption, mediaUrl, mediaType, user_id, mediaWidth, mediaHeight], (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            res.status(201).json({
                success: true,
                message: "Story uploaded successfully",
                storyId: result.insertId,
                mediaUrl,
                mediaType,
                mediaWidth,
                mediaHeight,
            });
        });
    } catch (error) {
        console.error("S3 Upload Error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to upload media to S3.",
            data: null,
        });
    }
});

module.exports = router;

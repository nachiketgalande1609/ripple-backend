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
                u.id AS user_id, u.username, u.profile_picture
            FROM stories s
            JOIN followers f ON s.user_id = f.following_id
            JOIN users u ON s.user_id = u.id
            WHERE f.follower_id = ? 
              AND s.is_active = 1
              AND (s.expires_at IS NULL OR s.expires_at > NOW())
            ORDER BY s.created_at DESC
        `;

        db.query(query, [userId], (err, results) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

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

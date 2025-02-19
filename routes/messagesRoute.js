const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const upload = multer({ storage: multer.memoryStorage() });
const sharp = require("sharp");

const fs = require("fs");
const path = require("path");
const os = require("os");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

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
            SELECT message_id ,sender_id, receiver_id, message_text, file_url, timestamp , delivered, delivered_timestamp, is_read, read_timestamp, file_name, file_size, reply_to, media_width, media_height
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
                            message_id: msg.message_id,
                            sender_id: msg.sender_id,
                            message_text: msg.message_text,
                            file_url: msg.file_url,
                            timestamp: msg.timestamp,
                            delivered: msg.delivered,
                            read: msg.is_read,
                            delivered_timestamp: msg.delivered_timestamp,
                            read_timestamp: msg.read_timestamp,
                            file_name: msg.file_name,
                            file_size: msg.file_size,
                            reply_to: msg.reply_to,
                            media_width: msg.media_width,
                            media_height: msg.media_height,
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

router.post("/media", upload.single("image"), async (req, res) => {
    const file = req.file;

    if (!file) {
        return res.status(400).json({
            success: false,
            error: "No file uploaded.",
            data: null,
        });
    }

    const fileName = file.originalname;
    const fileSize = file.size;
    const fileType = file.mimetype;
    let mediaWidth = null;
    let mediaHeight = null;

    try {
        if (fileType.startsWith("image/")) {
            const metadata = await sharp(file.buffer).metadata();
            mediaWidth = metadata.width;
            mediaHeight = metadata.height;
        } else if (fileType.startsWith("video/")) {
            // Write buffer to a temp file
            const tempFilePath = path.join(os.tmpdir(), `${Date.now()}_${fileName}`);
            fs.writeFileSync(tempFilePath, file.buffer);

            await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(tempFilePath, (err, metadata) => {
                    if (err) {
                        console.error("Error processing video:", err);
                        reject(err);
                    } else {
                        mediaWidth = metadata.streams[0]?.width || null;
                        mediaHeight = metadata.streams[0]?.height || null;
                        resolve();
                    }
                });
            });

            // Delete the temporary file after processing
            fs.unlinkSync(tempFilePath);
        }
    } catch (err) {
        console.error("Error processing media:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to process media.",
            data: null,
        });
    }

    const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: `chat/${Date.now()}_${fileName}`,
        Body: file.buffer,
        ContentType: fileType,
        ACL: "public-read",
    };

    try {
        const command = new PutObjectCommand(uploadParams);
        await s3.send(command);

        const fileUrl = `https://${uploadParams.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadParams.Key}`;

        return res.status(200).json({
            success: true,
            error: null,
            data: {
                fileUrl,
                fileName,
                fileSize,
                fileType,
                mediaWidth,
                mediaHeight,
            },
        });
    } catch (error) {
        console.error("S3 Upload Error:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to upload media to S3.",
            data: null,
        });
    }
});

module.exports = router;

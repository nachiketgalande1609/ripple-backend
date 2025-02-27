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
router.get("/fetch-users-messages", (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];

    // Fetch users the current user has messaged with, excluding the current user
    db.query(
        `
        SELECT DISTINCT u.id, u.username, u.profile_picture, u.public_key 
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
                    SELECT 
                        m.message_id, m.sender_id, m.receiver_id, m.message_text, 
                        m.file_url, m.timestamp, m.delivered, m.delivered_timestamp, 
                        m.is_read, m.read_timestamp, m.file_name, m.file_size, 
                        m.reply_to, m.media_width, m.media_height, m.reactions, m.post_id,
                        
                        p.file_url AS post_file_url, p.media_width AS post_media_width, 
                        p.media_height AS post_media_height, p.content AS post_content, p.user_id AS post_owner_id,

                        u.username AS post_owner_username, u.profile_picture AS post_owner_profile_picture
                    FROM messages m
                    LEFT JOIN posts p ON m.post_id = p.id
                    LEFT JOIN users u ON p.user_id = u.id
                    WHERE m.sender_id = ? OR m.receiver_id = ?
                    ORDER BY m.timestamp ASC;
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
                            reactions: msg.reactions,
                            post: msg.post_id
                                ? {
                                      post_id: msg.post_id,
                                      file_url: msg.post_file_url,
                                      media_width: msg.post_media_width,
                                      media_height: msg.post_media_height,
                                      content: msg.post_content,
                                      owner: {
                                          user_id: msg.post_owner_id,
                                          username: msg.post_owner_username,
                                          profile_picture: msg.post_owner_profile_picture,
                                      },
                                  }
                                : null,
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

router.post("/send-media", upload.single("image"), async (req, res) => {
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

// Delete Message
router.delete("/delete-message", async (req, res) => {
    const { currentUserId, messageId } = req.query;

    if (!messageId) {
        return res.status(400).json({
            success: false,
            error: "Message ID is required.",
            data: null,
        });
    }

    try {
        // Check if message exists
        db.query("SELECT file_url FROM messages WHERE message_id = ?", [messageId], async (err, results) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            if (results.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "Message not found.",
                    data: null,
                });
            }

            const fileUrl = results[0].file_url;

            // Delete message from database
            db.query("DELETE FROM messages WHERE message_id = ?", [messageId], async (deleteErr) => {
                if (deleteErr) {
                    return res.status(500).json({
                        success: false,
                        error: deleteErr.message,
                        data: null,
                    });
                }

                // If there's a file attached, delete it from S3
                if (fileUrl) {
                    const key = fileUrl.split(".amazonaws.com/")[1]; // Extract S3 object key

                    const deleteParams = {
                        Bucket: process.env.AWS_S3_BUCKET_NAME,
                        Key: key,
                    };

                    try {
                        await s3.send(new DeleteObjectCommand(deleteParams));
                    } catch (s3Error) {
                        console.error("S3 Deletion Error:", s3Error);
                    }
                }

                return res.json({
                    success: true,
                    error: null,
                    data: "Message deleted successfully.",
                });
            });
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
            data: null,
        });
    }
});

module.exports = router;

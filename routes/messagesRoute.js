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
const util = require("util");
const dbQuery = util.promisify(db.query).bind(db);

router.get("/fetch-users", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];

    try {
        const query = `
            SELECT DISTINCT 
                u.id, 
                u.username, 
                u.profile_picture, 
                u.public_key,

                -- Latest message exchanged with the user
                (
                    SELECT m1.message_text
                    FROM messages m1
                    WHERE 
                        (m1.sender_id = u.id AND m1.receiver_id = ?) OR 
                        (m1.receiver_id = u.id AND m1.sender_id = ?)
                    ORDER BY m1.timestamp DESC
                    LIMIT 1
                ) AS latest_message,

                -- Timestamp of the latest message
                (
                    SELECT m2.timestamp
                    FROM messages m2
                    WHERE 
                        (m2.sender_id = u.id AND m2.receiver_id = ?) OR 
                        (m2.receiver_id = u.id AND m2.sender_id = ?)
                    ORDER BY m2.timestamp DESC
                    LIMIT 1
                ) AS latest_message_timestamp,

                -- Count of unread messages from the user
                (
                    SELECT COUNT(*)
                    FROM messages m3
                    WHERE 
                        m3.sender_id = u.id AND 
                        m3.receiver_id = ? AND 
                        m3.is_read = 0
                ) AS unread_count
            FROM users u
            JOIN messages m 
                ON u.id = m.sender_id OR u.id = m.receiver_id
            WHERE 
                (m.sender_id = ? OR m.receiver_id = ?) AND 
                u.id != ?
            ORDER BY u.username;
        `;

        const usersResults = await dbQuery(query, [
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
        ]);

        return res.json({
            success: true,
            data: usersResults,
            error: null,
        });
    } catch (err) {
        console.error("Error fetching users:", err);
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

router.get("/fetch-messages", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const selectedUserId = req.query.selectedUserId;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    if (!currentUserId || !selectedUserId) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields: currentUserId or selectedUserId",
            data: null,
        });
    }

    const query = `
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
        WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
        ORDER BY m.timestamp DESC, m.message_id DESC
        LIMIT ? OFFSET ?;
    `;

    try {
        // Fetch the messages
        const [messagesResults] = await db.promise().query(query, [currentUserId, selectedUserId, selectedUserId, currentUserId, limit, offset]);

        // Extract all user IDs from reactions
        const allUserIds = new Set();
        messagesResults.forEach((msg) => {
            if (msg.reactions) {
                let reactions = msg.reactions;

                if (typeof reactions === "string") {
                    try {
                        reactions = JSON.parse(reactions);
                    } catch (error) {
                        console.error("Error parsing reactions JSON:", error);
                        return;
                    }
                }

                Object.keys(reactions).forEach((userId) => {
                    allUserIds.add(userId);
                });
            }
        });

        // Fetch user data if there are any user IDs
        const userIds = Array.from(allUserIds);
        let userMap = {};
        if (userIds.length > 0) {
            const [usersResults] = await db.promise().query(`SELECT id, username, profile_picture FROM users WHERE id IN (?);`, [userIds]);

            userMap = usersResults.reduce((acc, user) => {
                acc[user.id] = user;
                return acc;
            }, {});
        }

        // Organize messages by chat partner
        const groupedMessages = messagesResults.reduce((acc, msg) => {
            const chatPartnerId = msg.sender_id === parseInt(currentUserId) ? msg.receiver_id : msg.sender_id;

            if (!acc[chatPartnerId]) {
                acc[chatPartnerId] = [];
            }

            // Parse and map reactions
            let reactionsWithUserData = [];
            if (msg.reactions) {
                let reactions = msg.reactions;

                if (typeof reactions === "string") {
                    try {
                        reactions = JSON.parse(reactions);
                    } catch (error) {
                        console.error("Error parsing reactions JSON:", error);
                        return;
                    }
                }

                reactionsWithUserData = Object.keys(reactions).map((userId) => {
                    const user = userMap[userId];
                    return {
                        user_id: userId,
                        reaction: reactions[userId],
                        username: user ? user.username : null,
                        profile_picture: user ? user.profile_picture : null,
                    };
                });
            }

            acc[chatPartnerId].push({
                message_id: msg.message_id,
                sender_id: msg.sender_id,
                receiver_id: msg.receiver_id,
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
                reactions: reactionsWithUserData,
                saved: true,
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

            return acc;
        }, {});

        // Respond with the grouped messages
        res.status(200).json({
            success: true,
            data: groupedMessages[selectedUserId] || [],
            error: null,
        });
    } catch (err) {
        console.error("Error fetching messages:", err);
        res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
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

    let resizedMediaBuffer;

    try {
        if (fileType.startsWith("image/")) {
            // Process image file
            const image = sharp(file.buffer);
            image.resize({ width: 1080 });
            resizedMediaBuffer = await image.toBuffer();

            const metadata = await sharp(resizedMediaBuffer).metadata();
            mediaWidth = metadata.width;
            mediaHeight = metadata.height;
        } else if (fileType.startsWith("video/")) {
            // Process video file
            const tempInputPath = path.join(os.tmpdir(), `${Date.now()}_${fileName}`);
            fs.writeFileSync(tempInputPath, file.buffer);

            const tempOutputPath = path.join(os.tmpdir(), `resized_${Date.now()}_${fileName}`);
            await new Promise((resolve, reject) => {
                ffmpeg(tempInputPath)
                    .outputOptions([
                        "-vf",
                        "scale=720:-2", // maintain aspect ratio
                        "-preset",
                        "fast",
                        "-crf",
                        "28", // adjust quality/size balance
                    ])
                    .output(tempOutputPath)
                    .on("end", resolve)
                    .on("error", reject)
                    .run();
            });

            resizedMediaBuffer = fs.readFileSync(tempOutputPath);

            // Get video metadata (width and height)
            await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(tempOutputPath, (err, metadata) => {
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

            fs.unlinkSync(tempInputPath);
            fs.unlinkSync(tempOutputPath);
        } else {
            // Non-image and non-video file type (handle as generic file)
            resizedMediaBuffer = file.buffer;
        }
    } catch (err) {
        console.error("Error processing media:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to process media.",
            data: null,
        });
    }

    // Upload media to S3
    const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: `chat/${Date.now()}_${fileName}`,
        Body: resizedMediaBuffer,
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
    const { messageId } = req.query;

    if (!messageId) {
        return res.status(400).json({
            success: false,
            error: "Message ID is required.",
            data: null,
        });
    }

    try {
        // Check if message exists
        const [results] = await db.promise().query("SELECT file_url FROM messages WHERE message_id = ?", [messageId]);

        if (results.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Message not found.",
                data: null,
            });
        }

        const fileUrl = results[0].file_url;

        // Delete message from database
        await db.promise().query("DELETE FROM messages WHERE message_id = ?", [messageId]);

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
                // Handle S3 deletion error gracefully (still return message deletion success)
            }
        }

        return res.json({
            success: true,
            error: null,
            data: "Message deleted successfully.",
        });
    } catch (error) {
        console.error("Error in delete-message route:", error);
        return res.status(500).json({
            success: false,
            error: error.message,
            data: null,
        });
    }
});

module.exports = router;

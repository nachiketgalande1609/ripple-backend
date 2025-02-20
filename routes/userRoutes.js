const express = require("express");
const db = require("../db");
const router = express.Router();
const sharp = require("sharp");

const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

router.get("/profile/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const { currentUserId } = req.query;

        // Fetch user profile
        const userQuery = "SELECT id, username, email, bio, profile_picture, is_private FROM users WHERE id = ?";
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

router.post("/profile/picture", upload.single("profile_pic"), async (req, res) => {
    const { user_id } = req.body;
    const file = req.file;

    // Validate required fields
    if (!user_id || !file) {
        return res.status(400).json({
            success: false,
            error: "User ID and profile picture are required.",
            data: null,
        });
    }

    try {
        // Resize the image using sharp
        const resizedImageBuffer = await sharp(file.buffer)
            .resize({ width: 300, height: 300, fit: "cover" }) // Resize to 300x300
            .toFormat("jpeg")
            .toBuffer();

        // Define S3 upload parameters
        const uploadParams = {
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: `profile_pictures/${Date.now()}_${file.originalname}`,
            Body: resizedImageBuffer,
            ContentType: "image/jpeg",
            ACL: "public-read",
        };

        // Upload the file to S3
        const command = new PutObjectCommand(uploadParams);
        await s3.send(command);

        // Construct the image URL
        const fileUrl = `https://${uploadParams.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadParams.Key}`;

        // Update the user's profile picture URL in the database
        const query = "UPDATE users SET profile_picture = ? WHERE id = ?";
        db.query(query, [fileUrl, user_id], (err, result) => {
            if (err) {
                console.error("Database error:", err.message);
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            return res.status(200).json({
                success: true,
                message: "Profile picture updated successfully.",
                fileUrl,
            });
        });
    } catch (error) {
        console.error("Error processing image:", error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            data: null,
        });
    }
});

router.put("/profile/update", async (req, res) => {
    const { userId, updatedProfile } = req.body;

    // Validate required fields
    if (!userId || !updatedProfile) {
        return res.status(400).json({
            success: false,
            error: "Nothing to update",
            data: null,
        });
    }

    const { username, email, bio, profile_picture_url } = updatedProfile;

    try {
        // Prepare the update query with dynamic fields
        let query = "UPDATE users SET ";
        const values = [];

        // Only add the fields that were provided in the request
        if (username) {
            query += "username = ?, ";
            values.push(username);
        }
        if (email) {
            query += "email = ?, ";
            values.push(email);
        }
        if (bio) {
            query += "bio = ?, ";
            values.push(bio);
        }
        if (profile_picture_url) {
            query += "profile_picture = ?, ";
            values.push(profile_picture_url);
        }

        // Remove the trailing comma and space
        query = query.slice(0, -2);

        query += " WHERE id = ?";
        values.push(userId);

        // Execute the query with the provided parameters
        const [result] = await db.promise().query(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found or no changes made.",
                data: null,
            });
        }

        // Fetch the updated user data
        const [updatedUserResults] = await db.promise().query("SELECT id, username, email, bio, profile_picture FROM users WHERE id = ?", [userId]);

        const updatedUser = updatedUserResults[0];

        res.status(200).json({
            success: true,
            message: "Profile updated successfully.",
            data: updatedUser,
        });
    } catch (error) {
        console.error("Error updating profile:", error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            data: null,
        });
    }
});

module.exports = router;

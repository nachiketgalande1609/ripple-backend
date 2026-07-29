const express = require("express");
const { promisePool: db } = require("../db");
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

// Auto-add pronouns column if missing
(async () => {
    try {
        const [cols] = await db.query(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pronouns'"
        );
        if (cols.length === 0) {
            await db.query("ALTER TABLE users ADD COLUMN pronouns VARCHAR(50) DEFAULT NULL");
        }
    } catch (e) { console.error("pronouns column check failed:", e); }
})();

// Ensure profile_views table exists
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS profile_views (
                id INT AUTO_INCREMENT PRIMARY KEY,
                profile_user_id INT NOT NULL,
                viewer_id INT NOT NULL,
                viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_profile (profile_user_id),
                INDEX idx_viewer (viewer_id)
            )
        `);
    } catch (e) { console.error("profile_views table check failed:", e); }
})();

// Auto-add premium columns if missing
(async () => {
    try {
        const [cols] = await db.query(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_premium'"
        );
        if (cols.length === 0) {
            await db.query("ALTER TABLE users ADD COLUMN is_premium TINYINT(1) NOT NULL DEFAULT 0");
            await db.query("ALTER TABLE users ADD COLUMN premium_expires_at DATETIME DEFAULT NULL");
        }
    } catch (e) { console.error("premium columns check failed:", e); }
})();

router.get("/fetch-profile-details", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        const { userId } = req.query;

        // Fetch user profile
        const userQuery = "SELECT id, username, email, bio, profile_picture, website, pronouns, is_private, hide_activity, is_premium, premium_expires_at, IF(hide_activity = 1, NULL, last_seen) AS last_seen FROM users WHERE id = ?";
        const [userResults] = await db.query(userQuery, [userId]);

        if (userResults.length === 0) {
            return res.status(404).json({ success: false, error: "User not found", data: null });
        }

        const user = userResults[0];

        // Check if either user has blocked the other
        if (currentUserId && currentUserId != userId) {
            const [blockRows] = await db.query(
                `SELECT 1 FROM blocked_users
                 WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
                 LIMIT 1`,
                [currentUserId, userId, userId, currentUserId]
            );
            if (blockRows.length > 0) {
                return res.status(403).json({ success: false, error: "blocked", data: null });
            }
        }

        // Execute all queries concurrently
        const [[postResults], [followersResults], [followingResults], [followRequestResults], [followResults]] = await Promise.all([
            db.query("SELECT COUNT(id) AS posts_count FROM posts WHERE user_id = ?", [userId]),
            db.query("SELECT COUNT(*) AS followers_count FROM followers WHERE following_id = ?", [userId]),
            db.query("SELECT COUNT(*) AS following_count FROM followers WHERE follower_id = ?", [userId]),
            db.query(
                `
                SELECT status 
                FROM follow_requests 
                WHERE follower_id = ? AND following_id = ? 
                ORDER BY created_at DESC LIMIT 1`,
                [currentUserId, userId],
            ),
            db.query(
                `
                SELECT 1 FROM followers 
                WHERE follower_id = ? AND following_id = ? LIMIT 1`,
                [currentUserId, userId],
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

router.post("/update-profile-picture", upload.single("profile_pic"), async (req, res) => {
    try {
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

        // Resize image
        const resizedImageBuffer = await sharp(file.buffer).resize({ width: 150, height: 150, fit: "cover" }).toFormat("jpeg").toBuffer();

        // Upload to S3
        const uploadParams = {
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: `profile_pictures/${Date.now()}_${file.originalname}`,
            Body: resizedImageBuffer,
            ContentType: "image/jpeg",
            ACL: "public-read",
        };

        const command = new PutObjectCommand(uploadParams);
        await s3.send(command);

        const fileUrl = `https://${uploadParams.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadParams.Key}`;

        // ✅ DB using promise
        const query = "UPDATE users SET profile_picture = ? WHERE id = ?";
        await db.query(query, [fileUrl, user_id]);

        return res.status(200).json({
            success: true,
            message: "Profile picture updated successfully.",
            fileUrl,
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

router.put("/profile/update-profile-details", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { updatedProfile } = req.body;

    // Validate required fields
    if (!currentUserId || !updatedProfile) {
        return res.status(400).json({
            success: false,
            error: "Nothing to update",
            data: null,
        });
    }

    const { username, email, bio, profile_picture_url, website, pronouns } = updatedProfile;

    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (username && !usernameRegex.test(username)) {
        return res.status(400).json({
            success: false,
            error: "Invalid 'username'. It can only contain letters, numbers, and underscores.",
            data: null,
        });
    }

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
        if (website !== undefined) {
            query += "website = ?, ";
            values.push(website);
        }
        if (pronouns !== undefined) {
            query += "pronouns = ?, ";
            values.push(pronouns || null);
        }

        // Remove the trailing comma and space
        query = query.slice(0, -2);

        query += " WHERE id = ?";
        values.push(currentUserId);

        // Execute the query with the provided parameters
        const [result] = await db.query(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found or no changes made.",
                data: null,
            });
        }

        // Fetch the updated user data
        const [updatedUserResults] = await db.query("SELECT id, username, email, bio, profile_picture, website FROM users WHERE id = ?", [currentUserId]);

        const updatedUser = updatedUserResults[0];

        res.status(200).json({
            success: true,
            message: "Profile updated successfully.",
            data: updatedUser,
        });
    } catch (error) {
        console.error("Error updating profile:", error.message);
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(400).json({
                success: false,
                error: "Username already exists",
                data: null,
            });
        }

        return res.status(500).json({
            success: false,
            error: "Something went wrong. Please try again.",
            data: null,
        });
    }
});

// GET /api/users/suggestions
router.get("/suggestions", async (req, res) => {
    try {
        const currentUserId = req.headers["x-current-user-id"];
        if (!currentUserId) {
            return res.status(400).json({ success: false, error: "Missing x-current-user-id header" });
        }

        const sql = `
            SELECT u.id, u.username, u.profile_picture,
                (SELECT COUNT(*) FROM followers WHERE following_id = u.id) AS follower_count,
                (SELECT COUNT(*) FROM followers f2
                 WHERE f2.following_id = u.id
                 AND f2.follower_id IN (SELECT following_id FROM followers WHERE follower_id = ?)) AS mutual_count
            FROM users u
            WHERE u.id != ?
              AND u.is_deactivated = 0
              AND u.id NOT IN (SELECT following_id FROM followers WHERE follower_id = ?)
              AND u.id NOT IN (SELECT following_id FROM follow_requests WHERE follower_id = ? AND status = 'pending')
            ORDER BY mutual_count DESC, follower_count DESC
            LIMIT 8
        `;

        const [rows] = await db.query(sql, [currentUserId, currentUserId, currentUserId, currentUserId]);
        res.status(200).json({ success: true, data: rows });
    } catch (err) {
        console.error("Error fetching suggestions:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/users/record-view/:profileUserId
router.post("/record-view/:profileUserId", async (req, res) => {
    const { profileUserId } = req.params;
    const viewerId = req.headers["x-current-user-id"];
    if (!viewerId || String(viewerId) === String(profileUserId)) return res.json({ ok: false });
    try {
        await db.query(
            "INSERT INTO profile_views (profile_user_id, viewer_id) VALUES (?, ?)",
            [profileUserId, viewerId]
        );
        res.json({ ok: true });
    } catch {
        res.json({ ok: false });
    }
});

// GET /api/users/profile-views  (premium-gated)
router.get("/profile-views", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
    try {
        const [[user]] = await db.query(
            "SELECT is_premium, premium_expires_at FROM users WHERE id = ?", [currentUserId]
        );
        const active = user?.is_premium === 1 &&
            (!user.premium_expires_at || new Date(user.premium_expires_at) > new Date());
        if (!active) return res.status(403).json({ success: false, error: "premium_required" });

        const [rows] = await db.query(
            `SELECT pv.id, pv.viewer_id,
                    pv.viewed_at,
                    u.username, u.profile_picture
             FROM profile_views pv
             JOIN users u ON u.id = pv.viewer_id
             WHERE pv.profile_user_id = ?
             ORDER BY pv.id DESC
             LIMIT 200`,
            [currentUserId]
        );
        // Deduplicate: keep most-recent view per viewer
        const seen = new Set();
        const unique = rows.filter(r => {
            if (seen.has(r.viewer_id)) return false;
            seen.add(r.viewer_id);
            return true;
        });
        res.json({ success: true, data: unique, total: rows.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/users/grant-premium  (stub — payment integration plugs in here)
router.post("/grant-premium", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
    try {
        const { duration_months = 1 } = req.body;
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + Number(duration_months));
        await db.query(
            "UPDATE users SET is_premium = 1, premium_expires_at = ? WHERE id = ?",
            [expiresAt, currentUserId]
        );
        res.json({ success: true, expires_at: expiresAt });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/users/cancel-premium
router.delete("/cancel-premium", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
    try {
        await db.query(
            "UPDATE users SET is_premium = 0, premium_expires_at = NULL WHERE id = ?",
            [currentUserId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/users/by-username/:username  (used for @mention navigation)
router.get("/by-username/:username", async (req, res) => {
    const { username } = req.params;
    try {
        const [[user]] = await db.query(
            "SELECT id, username, profile_picture FROM users WHERE username = ? LIMIT 1",
            [username]
        );
        if (!user) return res.status(404).json({ success: false, data: null });
        res.json({ success: true, data: user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

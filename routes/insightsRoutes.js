const express = require("express");
const router = express.Router();
const { promisePool: db } = require("../db");

// Ensure table exists
db.query(`
    CREATE TABLE IF NOT EXISTS profile_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        profile_user_id INT NOT NULL,
        viewer_id INT NOT NULL,
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_profile (profile_user_id),
        INDEX idx_viewed_at (viewed_at)
    )
`).catch(console.error);

// GET /api/insights/summary
router.get("/summary", async (req, res) => {
    const userId = req.headers["x-current-user-id"];
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        const [[postRow], [likesRow], [commentsRow], [savesRow], [followersRow], [followingRow], [topPosts], [storyRow], [postsByMonth], [viewsRow], [viewsByMonth], [repostsRow]] = await Promise.all([
            db.query("SELECT COUNT(*) AS total FROM posts WHERE user_id = ?", [userId]),
            db.query("SELECT COUNT(*) AS total FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.user_id = ?", [userId]),
            db.query("SELECT COUNT(*) AS total FROM comments c JOIN posts p ON c.post_id = p.id WHERE p.user_id = ? AND c.user_id != ?", [userId, userId]),
            db.query("SELECT COUNT(*) AS total FROM saved_posts sp JOIN posts p ON sp.post_id = p.id WHERE p.user_id = ?", [userId]),
            db.query("SELECT COUNT(*) AS total FROM followers WHERE following_id = ?", [userId]),
            db.query("SELECT COUNT(*) AS total FROM followers WHERE follower_id = ?", [userId]),
            db.query(`
                SELECT p.id, p.content, p.file_url,
                    (SELECT file_url FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.media_order LIMIT 1) AS first_media_url,
                    COUNT(DISTINCT l.id) AS like_count,
                    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
                    (SELECT COUNT(*) FROM saved_posts sp WHERE sp.post_id = p.id) AS save_count
                FROM posts p
                LEFT JOIN likes l ON l.post_id = p.id
                WHERE p.user_id = ?
                GROUP BY p.id, p.content, p.file_url
                ORDER BY like_count DESC
                LIMIT 10
            `, [userId]),
            db.query(`
                SELECT COUNT(s.id) AS story_count,
                    COALESCE(SUM(sv.view_count), 0) AS total_views
                FROM stories s
                LEFT JOIN (
                    SELECT story_id, COUNT(*) AS view_count FROM story_views GROUP BY story_id
                ) sv ON sv.story_id = s.id
                WHERE s.user_id = ?
            `, [userId]),
            db.query(`
                SELECT DATE_FORMAT(p.created_at, '%b') AS month,
                    MONTH(p.created_at) AS month_num,
                    YEAR(p.created_at) AS year,
                    COUNT(DISTINCT p.id) AS posts,
                    COUNT(l.id) AS likes
                FROM posts p
                LEFT JOIN likes l ON l.post_id = p.id
                WHERE p.user_id = ? AND p.created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
                GROUP BY YEAR(p.created_at), MONTH(p.created_at), DATE_FORMAT(p.created_at, '%b')
                ORDER BY year ASC, month_num ASC
            `, [userId]),
            db.query("SELECT COUNT(*) AS total FROM profile_views WHERE profile_user_id = ?", [userId]),
            db.query(`
                SELECT DATE_FORMAT(viewed_at, '%b') AS month,
                    MONTH(viewed_at) AS month_num,
                    YEAR(viewed_at) AS year,
                    COUNT(*) AS views
                FROM profile_views
                WHERE profile_user_id = ? AND viewed_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
                GROUP BY YEAR(viewed_at), MONTH(viewed_at), DATE_FORMAT(viewed_at, '%b')
                ORDER BY year ASC, month_num ASC
            `, [userId]),
            db.query("SELECT COUNT(*) AS total FROM reposts r JOIN posts p ON r.post_id = p.id WHERE p.user_id = ?", [userId]),
        ]);

        const totalPosts = postRow[0].total;
        const totalLikes = likesRow[0].total;

        res.json({
            total_posts: totalPosts,
            total_likes_received: totalLikes,
            total_comments_received: commentsRow[0].total,
            total_saves: savesRow[0].total,
            followers_count: followersRow[0].total,
            following_count: followingRow[0].total,
            avg_likes_per_post: totalPosts > 0 ? (totalLikes / totalPosts).toFixed(1) : "0",
            top_posts: topPosts,
            story_count: storyRow[0].story_count,
            story_total_views: storyRow[0].total_views,
            posts_by_month: postsByMonth,
            profile_views: viewsRow[0].total,
            profile_views_by_month: viewsByMonth,
            total_reposts: repostsRow[0].total,
        });
    } catch (err) {
        console.error("Insights error:", err);
        res.status(500).json({ error: "Failed to fetch insights" });
    }
});

module.exports = router;

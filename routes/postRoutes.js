const express = require("express");
const db = require("../db");
const router = express.Router();
const { getTimeAgo } = require("../utils/utils");
const { createNotification } = require("../utils/utils");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { emitUnreadNotificationCount, emitNotifications } = require("../utils/utils");
const sharp = require("sharp");
const util = require("util");
const dbQuery = util.promisify(db.query).bind(db);

const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Like Post
router.post("/like-post", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { postId } = req.body;

    if (!currentUserId || !postId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Post ID are required.",
            data: null,
        });
    }

    try {
        const existingLike = await dbQuery("SELECT * FROM likes WHERE user_id = ? AND post_id = ?", [currentUserId, postId]);

        if (existingLike.length > 0) {
            // Unlike the post
            await dbQuery("DELETE FROM likes WHERE user_id = ? AND post_id = ?", [currentUserId, postId]);

            const likeCountResult = await dbQuery("SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?", [postId]);

            return res.status(200).json({
                success: true,
                message: "Post unliked successfully.",
                like_count: likeCountResult[0].like_count,
            });
        } else {
            // Like the post
            await dbQuery("INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, NOW())", [currentUserId, postId]);

            const postResult = await dbQuery("SELECT user_id FROM posts WHERE id = ?", [postId]);

            const postAuthorId = postResult[0]?.user_id;

            if (!postAuthorId) {
                return res.status(404).json({
                    success: false,
                    error: "Post not found.",
                    data: null,
                });
            }

            // If liking own post
            if (currentUserId === postAuthorId) {
                const likeCountResult = await dbQuery("SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?", [postId]);

                return res.status(200).json({
                    success: true,
                    message: "You liked your own post.",
                    like_count: likeCountResult[0].like_count,
                });
            }

            const userResult = await dbQuery("SELECT username FROM users WHERE id = ?", [currentUserId]);

            const userName = userResult[0]?.username;

            if (!userName) {
                return res.status(404).json({
                    success: false,
                    error: "User not found.",
                    data: null,
                });
            }

            const notificationMessage = `liked your post.`;

            await createNotification(postAuthorId, currentUserId, "like", notificationMessage, postId);
            emitUnreadNotificationCount(postAuthorId);
            emitNotifications(postAuthorId, notificationMessage);

            const likeCountResult = await dbQuery("SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?", [postId]);

            return res.status(200).json({
                success: true,
                message: "Post liked successfully.",
                like_count: likeCountResult[0].like_count,
            });
        }
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

router.post("/submit-post-comment", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { postId, comment } = req.body;

    if (!currentUserId || !postId || !comment) {
        return res.status(400).json({
            success: false,
            error: "User ID, Post ID, and Comment content are required.",
            data: null,
        });
    }

    try {
        const insertResult = await dbQuery(
            "INSERT INTO comments (user_id, post_id, content, created_at) VALUES (?, ?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))",
            [currentUserId, postId, comment]
        );

        const commentId = insertResult.insertId;

        const postResult = await dbQuery("SELECT user_id FROM posts WHERE id = ?", [postId]);

        const postAuthorId = postResult[0]?.user_id;

        if (!postAuthorId) {
            return res.status(404).json({
                success: false,
                error: "Post not found.",
                data: null,
            });
        }

        if (currentUserId === postAuthorId) {
            return res.status(200).json({
                success: true,
                message: "You commented on your own post.",
                commentId,
            });
        }

        const notificationMessage = `commented on your post: "${comment}"`;

        await createNotification(postAuthorId, currentUserId, "comment", notificationMessage, postId, commentId);
        emitUnreadNotificationCount(postAuthorId);

        return res.status(201).json({
            success: true,
            message: "Comment added and notification sent successfully.",
            commentId,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

// Delete Comment
router.delete("/delete-comment", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { commentId } = req.body;

    if (!currentUserId || !commentId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Comment ID are required.",
            data: null,
        });
    }

    try {
        // Check if comment exists and get owner
        const commentResult = await dbQuery("SELECT user_id FROM comments WHERE id = ?", [commentId]);

        if (commentResult.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Comment not found.",
                data: null,
            });
        }

        const commentOwnerId = commentResult[0].user_id;

        if (commentOwnerId != currentUserId) {
            return res.status(403).json({
                success: false,
                error: "You are not authorized to delete this comment.",
                data: null,
            });
        }

        // Delete the comment
        await dbQuery("DELETE FROM comments WHERE id = ?", [commentId]);

        return res.status(200).json({
            success: true,
            error: null,
            data: "Comment deleted successfully.",
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

// Save Post
router.post("/save-post", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { postId } = req.body;

    // Validate inputs
    if (!currentUserId || !postId) {
        return res.status(400).json({
            success: false,
            error: "currentUserId and postId are required.",
            data: null,
        });
    }

    try {
        const checkSaved = await dbQuery("SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?", [currentUserId, postId]);

        if (checkSaved.length > 0) {
            // If post already saved, remove it (toggle off)
            await dbQuery("DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?", [currentUserId, postId]);

            return res.status(200).json({
                success: true,
                error: null,
                data: {
                    message: "Post removed from saved posts",
                    postId,
                },
            });
        } else {
            // If not saved, insert (toggle on)
            await dbQuery("INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)", [currentUserId, postId]);

            return res.status(200).json({
                success: true,
                error: null,
                data: {
                    message: "Post saved successfully",
                    postId,
                },
            });
        }
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

// Fetch Home Page Posts
router.get("/fetch-posts", async (req, res) => {
    try {
        const userId = req.headers["x-current-user-id"];

        const postsQuery = `
            SELECT u.username,
                   u.profile_picture,
                   p.*,
                   IF(sp.user_id IS NOT NULL, 1, 0) AS saved_by_current_user
            FROM posts p
            JOIN users u ON p.user_id = u.id
            LEFT JOIN saved_posts sp ON p.id = sp.post_id AND sp.user_id = ?
            WHERE p.user_id IN (
                SELECT following_id FROM followers WHERE follower_id = ?
                UNION
                SELECT ?
            )
            ORDER BY p.created_at DESC;
        `;

        const postsResult = await dbQuery(postsQuery, [userId, userId, userId]);
        if (!postsResult.length) {
            return res.status(200).json({ success: true, error: null, data: [] });
        }

        const postIds = postsResult.map((post) => post.id);
        if (postIds.length === 0) {
            return res.status(200).json({ success: true, error: null, data: [] });
        }

        // Like counts
        const likesQuery = `
            SELECT post_id, COUNT(*) AS like_count
            FROM likes
            WHERE post_id IN (?)
            GROUP BY post_id;
        `;
        const likesResult = await dbQuery(likesQuery, [postIds]);

        const likeCounts = likesResult.reduce((acc, like) => {
            acc[like.post_id] = like.like_count;
            return acc;
        }, {});

        // Posts liked by the current user
        let likedPostsByCurrentUser = new Set();
        if (userId) {
            const likedPostsQuery = `
                SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (?);
            `;
            const likedPostsResult = await dbQuery(likedPostsQuery, [userId, postIds]);
            likedPostsByCurrentUser = new Set(likedPostsResult.map((like) => like.post_id));
        }

        // Comments + comment likes
        const commentsQuery = `
            SELECT c.id, c.post_id, c.user_id, c.content, c.parent_comment_id,
                   c.created_at, c.updated_at,
                   u.username AS commenter_username, u.profile_picture AS commenter_profile_picture,
                   COUNT(cl.id) AS likes_count,
                   MAX(CASE WHEN cl.user_id = ? THEN 1 ELSE 0 END) AS liked_by_user
            FROM comments c
            INNER JOIN users u ON c.user_id = u.id
            LEFT JOIN comment_likes cl ON c.id = cl.comment_id
            WHERE c.post_id IN (?)
            GROUP BY c.id
            ORDER BY c.created_at DESC;
        `;
        const commentsResult = await dbQuery(commentsQuery, [userId, postIds]);

        // Organize comments by post_id
        const commentsByPostId = commentsResult.reduce((acc, comment) => {
            if (!acc[comment.post_id]) acc[comment.post_id] = [];
            comment.timeAgo = getTimeAgo(new Date(comment.created_at));
            comment.likes_count = Number(comment.likes_count) || 0;
            comment.liked_by_user = Boolean(comment.liked_by_user);
            acc[comment.post_id].push(comment);
            return acc;
        }, {});

        // Finalizing post objects
        const finalPosts = postsResult.map((post) => {
            return {
                ...post,
                timeAgo: getTimeAgo(new Date(post.created_at)),
                like_count: likeCounts[post.id] || 0,
                liked_by_current_user: likedPostsByCurrentUser.has(post.id) ? 1 : 0,
                comment_count: commentsByPostId[post.id]?.length || 0,
                comments: commentsByPostId[post.id] || [],
            };
        });

        return res.status(200).json({
            success: true,
            error: null,
            data: finalPosts,
        });
    } catch (error) {
        console.error("Error fetching posts:", error);
        return res.status(500).json({
            success: false,
            error: "An error occurred while fetching posts. Please try again later.",
            data: null,
        });
    }
});

// Fetch Profile Page Posts
router.get("/fetch-profile-posts", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { userId } = req.query;

    try {
        // Check if the user exists and is private
        const privacyQuery = `SELECT is_private FROM users WHERE id = ?;`;
        const userResult = await dbQuery(privacyQuery, [userId]);

        if (userResult.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const isPrivate = userResult[0].is_private;

        if (isPrivate && currentUserId != userId) {
            const followCheckQuery = `
                SELECT 1 
                FROM followers 
                WHERE follower_id = ? AND following_id = ?;
            `;
            const followResult = await dbQuery(followCheckQuery, [currentUserId, userId]);

            if (followResult.length === 0) {
                return res.status(403).json({
                    success: false,
                    error: "This account is private. You must follow the user to see their posts.",
                    data: null,
                });
            }
        }

        // Fetch posts if public or following
        await fetchPosts(userId, res);
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

// Fetch Post Details
router.get("/fetch-post-details", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { userId, postId } = req.query;

    try {
        // Check if user exists and is private
        const privacyQuery = `SELECT is_private FROM users WHERE id = ?;`;
        const userResult = await dbQuery(privacyQuery, [userId]);

        if (userResult.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const isPrivate = userResult[0].is_private;

        if (isPrivate && currentUserId != userId) {
            const followCheckQuery = `
                SELECT 1 
                FROM followers 
                WHERE follower_id = ? AND following_id = ?;
            `;
            const followResult = await dbQuery(followCheckQuery, [currentUserId, userId]);

            if (followResult.length === 0) {
                return res.status(403).json({
                    success: false,
                    error: "This account is private. You must follow the user to see their posts.",
                    data: null,
                });
            }
        }

        // Either public or allowed follower — fetch post details
        await fetchPostDetails(userId, postId, currentUserId, res);
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

// Create Post
router.post("/create-post", upload.single("image"), async (req, res) => {
    const { content, location, user_id } = req.body;
    const file = req.file;

    if (!content || !file) {
        return res.status(400).json({
            success: false,
            error: "Content and image are required.",
            data: null,
        });
    }

    const fileName = file.originalname;
    const fileType = file.mimetype;
    let mediaWidth = null;
    let mediaHeight = null;
    let resizedImageBuffer;

    if (fileType.startsWith("image/")) {
        try {
            const image = sharp(file.buffer).resize({ width: 1080 });
            resizedImageBuffer = await image.toBuffer();
            const metadata = await sharp(resizedImageBuffer).metadata();
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
    } else {
        resizedImageBuffer = file.buffer;
    }

    const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: `uploads/${Date.now()}_${fileName}`,
        Body: resizedImageBuffer,
        ContentType: fileType,
        ACL: "public-read",
    };

    try {
        const command = new PutObjectCommand(uploadParams);
        await s3.send(command);

        const fileUrl = `https://${uploadParams.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadParams.Key}`;

        const insertQuery = `
            INSERT INTO posts (content, file_url, location, user_id, media_width, media_height)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

        const result = await dbQuery(insertQuery, [content, fileUrl, location, user_id, mediaWidth, mediaHeight]);

        return res.status(201).json({
            success: true,
            error: null,
            message: "Post created successfully",
            postId: result.insertId,
            fileUrl,
            mediaWidth,
            mediaHeight,
        });
    } catch (error) {
        console.error("Error creating post:", error);
        return res.status(500).json({
            success: false,
            error: "Something went wrong while creating the post.",
            data: null,
        });
    }
});

// Update Post
router.post("/update/:postId", async (req, res) => {
    const { postId } = req.params;
    const { content } = req.body;

    if (!content) {
        return res.status(400).json({
            success: false,
            error: "At least one field is required for updating.",
            data: null,
        });
    }

    let query = "UPDATE posts SET ";
    const updates = [];
    const values = [];

    if (content) {
        updates.push("content = ?");
        values.push(content);
    }

    query += updates.join(", ") + " WHERE id = ?";
    values.push(postId);

    try {
        const result = await dbQuery(query, values);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "Post not found or no changes made.",
                data: null,
            });
        }

        return res.status(200).json({
            success: true,
            error: null,
            message: "Post updated successfully",
            data: {
                postId,
                updatedFields: {
                    content,
                },
            },
        });
    } catch (err) {
        console.error("Error updating post:", err);
        return res.status(500).json({
            success: false,
            error: "An error occurred while updating the post.",
            data: null,
        });
    }
});

// Delete Post
router.delete("/delete-post", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { postId } = req.query;

    if (!currentUserId) {
        return res.status(400).json({
            success: false,
            error: "User ID is required to delete the post",
            data: null,
        });
    }

    const checkOwnershipQuery = "SELECT * FROM posts WHERE id = ? AND user_id = ?";

    try {
        const result = await dbQuery(checkOwnershipQuery, [postId, currentUserId]);

        if (result.length === 0) {
            return res.status(403).json({
                success: false,
                error: "You can only delete your own posts",
                data: null,
            });
        }

        const deleteQuery = "DELETE FROM posts WHERE id = ?";
        await dbQuery(deleteQuery, [postId]);

        return res.status(200).json({
            success: true,
            error: null,
            message: "Post deleted successfully",
            data: null,
        });
    } catch (err) {
        console.error("Error deleting post:", err);
        return res.status(500).json({
            success: false,
            error: "An error occurred while deleting the post",
            data: null,
        });
    }
});

// Fetch Saved Posts
router.get("/fetch-saved-posts", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];

    try {
        // Fetch saved posts
        const savedPostsQuery = `
            SELECT u.username,
                u.profile_picture,
                p.*,
                IF(sp.user_id IS NOT NULL, 1, 0) AS saved_by_current_user
            FROM posts p
            INNER JOIN users u
                ON p.user_id = u.id
            INNER JOIN saved_posts sp
                ON p.id = sp.post_id
            WHERE sp.user_id = ?
            ORDER BY p.created_at DESC;
        `;
        const result = await dbQuery(savedPostsQuery, [currentUserId]);

        // Fetch like counts for each post
        const postIds = result.map((post) => post.id);

        if (postIds.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: result,
            });
        }

        const likesQuery = `
            SELECT 
                post_id, 
                COUNT(*) AS like_count
            FROM 
                likes
            WHERE 
                post_id IN (?)
            GROUP BY 
                post_id;
        `;
        const likesResult = await dbQuery(likesQuery, [postIds]);

        // Create a map of post_id to like_count
        const likeCounts = likesResult.reduce((acc, like) => {
            acc[like.post_id] = like.like_count;
            return acc;
        }, {});

        // Fetch liked posts by current user if provided
        const likedPostsQuery = `
            SELECT 
                post_id
            FROM 
                likes
            WHERE 
                user_id = ? 
                AND post_id IN (?);
        `;
        const likedPostsResult = currentUserId ? await dbQuery(likedPostsQuery, [currentUserId, postIds]) : [];

        const likedPostsByCurrentUser = new Set(likedPostsResult.map((like) => like.post_id));

        // Add like count and like status to posts
        result.forEach((post) => {
            const createdAt = new Date(post.created_at);
            post.timeAgo = getTimeAgo(createdAt);

            // Set the like count
            post.like_count = likeCounts[post.id] || 0;

            // If currentUserId is provided, check if the current user liked the post
            post.liked_by_current_user = likedPostsByCurrentUser.has(post.id) ? 1 : 0;
        });

        // Fetch comments for each post
        const commentsQuery = `
            SELECT 
                c.id, 
                c.post_id, 
                c.user_id, 
                c.content, 
                c.parent_comment_id, 
                c.created_at, 
                c.updated_at,
                u.username AS commenter_username, 
                u.profile_picture AS commenter_profile_picture,
                COUNT(cl.id) AS likes_count,
                MAX(CASE WHEN cl.user_id = ? THEN 1 ELSE 0 END) AS liked_by_user
            FROM 
                comments c
            INNER JOIN 
                users u ON c.user_id = u.id
            LEFT JOIN 
                comment_likes cl ON c.id = cl.comment_id
            WHERE 
                c.post_id IN (?)
            GROUP BY 
                c.id
            ORDER BY 
                c.created_at DESC;
        `;
        const commentsResult = await dbQuery(commentsQuery, [currentUserId, postIds]);

        // Organize comments by post_id and set timeAgo for each comment
        const commentsByPostId = commentsResult.reduce((acc, comment) => {
            if (!acc[comment.post_id]) {
                acc[comment.post_id] = [];
            }
            comment.timeAgo = getTimeAgo(new Date(comment.created_at)); // Set timeAgo for comment
            acc[comment.post_id].push(comment);
            return acc;
        }, {});

        // Add comment count and comments to posts
        result.forEach((post) => {
            post.comment_count = commentsByPostId[post.id] ? commentsByPostId[post.id].length : 0; // Add comment count
            post.comments = commentsByPostId[post.id] || []; // Add comments
        });

        return res.status(200).json({
            success: true,
            error: null,
            data: result,
        });
    } catch (err) {
        console.error("Error fetching saved posts:", err);
        return res.status(500).json({
            success: false,
            error: "An error occurred while fetching saved posts",
            data: null,
        });
    }
});

router.post("/like-comment", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { commentId } = req.body;

    if (!currentUserId || !commentId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Comment ID are required.",
            data: null,
        });
    }

    try {
        const existingLike = await dbQuery("SELECT * FROM comment_likes WHERE user_id = ? AND comment_id = ?", [currentUserId, commentId]);

        if (existingLike.length > 0) {
            // Unlike
            await dbQuery("DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?", [currentUserId, commentId]);

            const countResult = await dbQuery("SELECT COUNT(*) AS like_count FROM comment_likes WHERE comment_id = ?", [commentId]);

            return res.status(200).json({
                success: true,
                message: "Comment unliked successfully.",
                like_count: countResult[0].like_count,
            });
        } else {
            // Like
            await dbQuery("INSERT INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, NOW())", [currentUserId, commentId]);

            const commentResult = await dbQuery("SELECT user_id, post_id FROM comments WHERE id = ?", [commentId]);

            const commentAuthorId = commentResult[0]?.user_id;
            const postId = commentResult[0]?.post_id;

            if (!commentAuthorId) {
                return res.status(404).json({
                    success: false,
                    error: "Comment not found.",
                    data: null,
                });
            }

            // No notification if liking own comment
            if (currentUserId === commentAuthorId) {
                return res.status(200).json({
                    success: true,
                    message: "You liked your own comment.",
                });
            }

            const notificationMessage = "liked your comment.";

            await createNotification(commentAuthorId, currentUserId, "comment_like", notificationMessage, postId, commentId);
            emitUnreadNotificationCount(commentAuthorId);
            emitNotifications(commentAuthorId, notificationMessage);

            const countResult = await dbQuery("SELECT COUNT(*) AS like_count FROM comment_likes WHERE comment_id = ?", [commentId]);

            return res.status(200).json({
                success: true,
                message: "Comment liked successfully.",
                like_count: countResult[0].like_count,
            });
        }
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
});

async function fetchPosts(userId, res) {
    try {
        const postsQuery = `
            SELECT
                p.id,
                p.file_url
            FROM
                posts p
            WHERE
                p.user_id = ?
            ORDER BY
                p.created_at DESC;
        `;

        const result = await dbQuery(postsQuery, [userId]);

        if (result.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: [],
            });
        }

        return res.status(200).json({
            success: true,
            error: null,
            data: result,
        });
    } catch (err) {
        console.error("Error fetching posts:", err);
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
}

async function fetchPostDetails(userId, postId, currentUserId, res) {
    try {
        const postQuery = `
            SELECT
                p.id,
                u.username,
                u.profile_picture,
                p.file_url,
                p.content,
                p.created_at
            FROM
                posts p
            INNER JOIN
                users u ON p.user_id = u.id
            WHERE
                p.id = ? AND p.user_id = ?;
        `;

        const result = await dbQuery(postQuery, [postId, userId]);

        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                error: "Post not found",
                data: null,
            });
        }

        const post = result[0];

        const likesQuery = `
            SELECT
                post_id,
                user_id
            FROM
                likes
            WHERE
                post_id = ?;
        `;

        const likesResult = await dbQuery(likesQuery, [postId]);
        const likeCount = likesResult.length;

        const likedByCurrentUser = likesResult.some((like) => like.user_id == currentUserId);

        post.like_count = likeCount;
        post.liked_by_current_user = likedByCurrentUser ? 1 : 0;
        post.timeAgo = getTimeAgo(new Date(post.created_at));

        const commentsQuery = `
            SELECT
                c.id,
                c.post_id,
                c.user_id,
                c.content,
                c.parent_comment_id,
                c.created_at,
                c.updated_at,
                u.username AS commenter_username,
                u.profile_picture AS commenter_profile_picture,
                COUNT(cl.id) AS likes_count,
                MAX(CASE WHEN cl.user_id = ? THEN 1 ELSE 0 END) AS liked_by_user
            FROM
                comments c
            INNER JOIN
                users u ON c.user_id = u.id
            LEFT JOIN
                comment_likes cl ON c.id = cl.comment_id
            WHERE
                c.post_id = ?
            GROUP BY
                c.id
            ORDER BY
                c.created_at DESC;
        `;

        const commentsResult = await dbQuery(commentsQuery, [currentUserId, postId]);

        commentsResult.forEach((comment) => {
            comment.timeAgo = getTimeAgo(new Date(comment.created_at));
        });

        post.comment_count = commentsResult.length;
        post.comments = commentsResult;

        return res.status(200).json({
            success: true,
            error: null,
            data: post,
        });
    } catch (err) {
        console.error("Error fetching post details:", err);
        return res.status(500).json({
            success: false,
            error: err.message,
            data: null,
        });
    }
}

module.exports = router;

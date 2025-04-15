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

// Like Post
router.post("/like-post", (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { postId } = req.body;

    if (!currentUserId || !postId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Post ID are required.",
            data: null,
        });
    }

    const checkLikeQuery = "SELECT * FROM likes WHERE user_id = ? AND post_id = ?";

    db.query(checkLikeQuery, [currentUserId, postId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            // Unlike the post
            const removeLikeQuery = "DELETE FROM likes WHERE user_id = ? AND post_id = ?";

            db.query(removeLikeQuery, [currentUserId, postId], (err) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Calculate the updated like count from the likes table
                const likesCountQuery = "SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?";

                db.query(likesCountQuery, [postId], (err, countResult) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    res.status(200).json({
                        success: true,
                        message: "Post unliked successfully.",
                        like_count: countResult[0].like_count,
                    });
                });
            });
        } else {
            // Like the post
            const addLikeQuery = "INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, NOW())";

            db.query(addLikeQuery, [currentUserId, postId], (err) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Get the user ID of the post author
                const getPostAuthorQuery = "SELECT user_id FROM posts WHERE id = ?";

                db.query(getPostAuthorQuery, [postId], (err, postResult) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    const postAuthorId = postResult[0]?.user_id;
                    if (!postAuthorId) {
                        return res.status(404).json({
                            success: false,
                            error: "Post not found.",
                            data: null,
                        });
                    }

                    // Check if the user is liking their own post
                    if (currentUserId === postAuthorId) {
                        return res.status(200).json({
                            success: true,
                            message: "You liked your own post.",
                            like_count: result.length,
                        });
                    }

                    // Fetch the username of the user who liked the post
                    const getUserNameQuery = "SELECT username FROM users WHERE id = ?";

                    db.query(getUserNameQuery, [currentUserId], (err, userResult) => {
                        if (err) {
                            return res.status(500).json({
                                success: false,
                                error: err.message,
                                data: null,
                            });
                        }

                        const userName = userResult[0]?.username;
                        if (!userName) {
                            return res.status(404).json({
                                success: false,
                                error: "User not found.",
                                data: null,
                            });
                        }

                        // Create a notification for the post's author
                        const notificationMessage = `liked your post.`;
                        createNotification(postAuthorId, currentUserId, "like", notificationMessage, postId)
                            .then(() => {
                                emitUnreadNotificationCount(postAuthorId);
                                emitNotifications(postAuthorId, notificationMessage);

                                const likesCountQuery = "SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?";

                                db.query(likesCountQuery, [postId], (err, countResult) => {
                                    if (err) {
                                        return res.status(500).json({
                                            success: false,
                                            error: err.message,
                                            data: null,
                                        });
                                    }

                                    res.status(200).json({
                                        success: true,
                                        message: "Post liked successfully.",
                                        like_count: countResult[0].like_count,
                                    });
                                });
                            })
                            .catch((err) => {
                                return res.status(500).json({
                                    success: false,
                                    error: err.message,
                                    data: null,
                                });
                            });
                    });
                });
            });
        }
    });
});

// Comment on Post
router.post("/submit-post-comment", (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { postId, comment } = req.body;

    if (!currentUserId || !postId || !comment) {
        return res.status(400).json({
            success: false,
            error: "User ID, Post ID, and Comment content are required.",
            data: null,
        });
    }

    const insertCommentQuery = "INSERT INTO comments (user_id, post_id, content, created_at) VALUES (?, ?, ?, NOW())";

    db.query(insertCommentQuery, [currentUserId, postId, comment], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        const commentId = result.insertId;

        const getPostAuthorQuery = "SELECT user_id FROM posts WHERE id = ?";

        db.query(getPostAuthorQuery, [postId], (err, postResult) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            const postAuthorId = postResult[0]?.user_id;
            if (!postAuthorId) {
                return res.status(404).json({
                    success: false,
                    error: "Post not found.",
                    data: null,
                });
            }

            // Check if the user is commenting on their own post
            if (currentUserId === postAuthorId) {
                return res.status(200).json({
                    success: true,
                    message: "You commented on your own post.",
                    commentId: result.insertId,
                });
            }

            // Create a notification for the post's author, including the comment text and comment ID
            const notificationMessage = `commented on your post: "${comment}"`; // Include the comment content in the notification
            createNotification(postAuthorId, currentUserId, "comment", notificationMessage, postId, commentId)
                .then(() => {
                    emitUnreadNotificationCount(postAuthorId);
                    res.status(201).json({
                        success: true,
                        message: "Comment added and notification sent successfully.",
                        commentId: result.insertId,
                    });
                })
                .catch((err) => {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                });
        });
    });
});

// Delete Comment
router.delete("/delete-comment", (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { commentId } = req.body;

    if (!currentUserId || !commentId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Comment ID are required.",
            data: null,
        });
    }

    const getCommentQuery = "SELECT user_id FROM comments WHERE id = ?";
    db.query(getCommentQuery, [commentId], (err, commentResult) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

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

        const deleteCommentQuery = "DELETE FROM comments WHERE id = ?";
        db.query(deleteCommentQuery, [commentId], (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            return res.status(200).json({
                success: true,
                error: null,
                data: "Comment deleted successfully.",
            });
        });
    });
});

// Save Post
router.post("/save-post", (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];

    const { postId } = req.body;

    // Validate the input
    if (!currentUserId || !postId) {
        return res.status(400).json({
            success: false,
            error: "currentUserId and postId are required.",
            data: null,
        });
    }

    // Check if the post is already saved in the saved_posts table for this user
    const checkSavedPostQuery = `
        SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?
    `;

    db.query(checkSavedPostQuery, [currentUserId, postId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            // If the post is already saved, remove it (toggle action)
            const deleteSavedPostQuery = `
                DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?
            `;

            db.query(deleteSavedPostQuery, [currentUserId, postId], (err, result) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                res.status(200).json({
                    success: true,
                    error: null,
                    data: {
                        message: "Post removed from saved posts",
                        postId,
                    },
                });
            });
        } else {
            // If the post is not saved, save it (toggle action)
            const insertSavedPostQuery = `
                INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)
            `;

            db.query(insertSavedPostQuery, [currentUserId, postId], (err, result) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                res.status(200).json({
                    success: true,
                    error: null,
                    data: {
                        message: "Post saved successfully",
                        postId,
                    },
                });
            });
        }
    });
});

// Fetch Home Page Posts
router.get("/fetch-posts", async (req, res) => {
    try {
        const userId = req.headers["x-current-user-id"];

        let postsQuery = `
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

        // Fetch posts
        const [postsResult] = await db.promise().query(postsQuery, [userId, userId, userId]);
        if (!postsResult.length) {
            return res.status(200).json({
                success: true,
                error: null,
                data: [],
            });
        }

        // Extract post IDs
        const postIds = postsResult.map((post) => post.id);
        if (postIds.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: [],
            });
        }

        // Fetch like counts
        let likesQuery = `SELECT post_id, COUNT(*) AS like_count FROM likes WHERE post_id IN (?) GROUP BY post_id;`;
        const [likesResult] = await db.promise().query(likesQuery, [postIds]);
        const likeCounts = likesResult.reduce((acc, like) => {
            acc[like.post_id] = like.like_count;
            return acc;
        }, {});

        // Fetch liked posts by the user
        let likedPostsByCurrentUser = new Set();
        if (userId) {
            let likedPostsQuery = `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (?);`;
            const [likedPostsResult] = await db.promise().query(likedPostsQuery, [userId, postIds]);
            likedPostsByCurrentUser = new Set(likedPostsResult.map((like) => like.post_id));
        }

        // Fetch comments
        let commentsQuery = `
            SELECT c.id, c.post_id, c.user_id, c.content, c.parent_comment_id, c.created_at, c.updated_at, 
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
        const [commentsResult] = await db.promise().query(commentsQuery, [userId, postIds]);

        console.log("xxx", commentsResult);

        // Organize comments by post_id
        const commentsByPostId = commentsResult.reduce((acc, comment) => {
            if (!acc[comment.post_id]) {
                acc[comment.post_id] = [];
            }
            comment.timeAgo = getTimeAgo(new Date(comment.created_at));
            comment.likes_count = Number(comment.likes_count) || 0;
            comment.liked_by_user = Boolean(comment.liked_by_user);
            acc[comment.post_id].push(comment);
            return acc;
        }, {});

        // Finalize posts data
        postsResult.forEach((post) => {
            post.timeAgo = getTimeAgo(new Date(post.created_at));
            post.like_count = likeCounts[post.id] || 0;
            post.liked_by_current_user = likedPostsByCurrentUser.has(post.id) ? 1 : 0;
            post.comment_count = commentsByPostId[post.id] ? commentsByPostId[post.id].length : 0;
            post.comments = commentsByPostId[post.id] || [];
        });

        return res.status(200).json({
            success: true,
            error: null,
            data: postsResult,
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
router.get(["/fetch-profile-posts"], (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { userId } = req.query;

    // Query to check if the user is private
    const privacyQuery = `
        SELECT is_private 
        FROM users 
        WHERE id = ?;
    `;

    db.query(privacyQuery, [userId], (err, userResult) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (userResult.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const isPrivate = userResult[0].is_private;

        if (isPrivate && currentUserId != userId) {
            // Check if the current user is following this private account
            const followCheckQuery = `
                SELECT 1 
                FROM followers 
                WHERE follower_id = ? AND following_id = ?;
            `;

            db.query(followCheckQuery, [currentUserId, userId], (err, followResult) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                if (followResult.length === 0) {
                    return res.status(403).json({
                        success: false,
                        error: "This account is private. You must follow the user to see their posts.",
                        data: null,
                    });
                }

                // User is following, so proceed with fetching posts
                fetchPosts(userId, currentUserId, res);
            });
        } else {
            // User is public, proceed with fetching posts
            fetchPosts(userId, currentUserId, res);
        }
    });
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
            const image = sharp(file.buffer);
            image.resize({ width: 1080 });

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

        // Insert post into database with image dimensions
        const query = `
            INSERT INTO posts (content, file_url, location, user_id, media_width, media_height)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        db.query(query, [content, fileUrl, location, user_id, mediaWidth, mediaHeight], (err, result) => {
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
                fileUrl,
                mediaWidth,
                mediaHeight,
            });
        });
    } catch (error) {
        console.error("S3 Upload Error:", error);
        res.status(500).json({
            success: false,
            error: "Failed to upload image to S3.",
            data: null,
        });
    }
});

// Update Post
router.post("/update/:postId", (req, res) => {
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

    db.query(query, values, (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                error: "Post not found or no changes made.",
                data: null,
            });
        }

        res.status(200).json({
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
    });
});

// Delete Post
router.delete("/delete-post", (req, res) => {
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

    db.query(checkOwnershipQuery, [postId, currentUserId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length === 0) {
            return res.status(403).json({
                success: false,
                error: "You can only delete your own posts",
                data: null,
            });
        }

        const deleteQuery = "DELETE FROM posts WHERE id = ?";

        db.query(deleteQuery, [postId], (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            res.status(200).json({
                success: true,
                error: null,
                message: "Post deleted successfully",
                data: null,
            });
        });
    });
});

// Fetch Saved Posts
router.get(["/fetch-saved-posts"], (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];

    let savedPostsQuery = `
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

    db.query(savedPostsQuery, [currentUserId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // Fetch like counts for each post
        const postIds = result.map((post) => post.id);

        if (postIds.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: result,
            });
        }

        let likesQuery = `
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

        db.query(likesQuery, [postIds], (err, likesResult) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            // Create a map of post_id to like_count
            const likeCounts = likesResult.reduce((acc, like) => {
                acc[like.post_id] = like.like_count;
                return acc;
            }, {});

            // If currentUserId is provided, fetch liked posts by the current user
            if (currentUserId) {
                let likedPostsQuery = `
                    SELECT 
                        post_id
                    FROM 
                        likes
                    WHERE 
                        user_id = ? 
                        AND post_id IN (?);
                `;

                db.query(likedPostsQuery, [currentUserId, postIds], (err, likedPostsResult) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    // Create a set of post_ids that the user has liked
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
                    let commentsQuery = `
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

                    db.query(commentsQuery, [currentUserId, postIds], (err, commentsResult) => {
                        if (err) {
                            return res.status(500).json({
                                success: false,
                                error: err.message,
                                data: null,
                            });
                        }

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

                        res.status(200).json({
                            success: true,
                            error: null,
                            data: result,
                        });
                    });
                });
            } else {
                // If no currentUserId is provided, simply return the posts with like counts
                result.forEach((post) => {
                    post.like_count = likeCounts[post.id] || 0;
                });

                res.status(200).json({
                    success: true,
                    error: null,
                    data: result,
                });
            }
        });
    });
});

function fetchPosts(userId, currentUserId, res) {
    let postsQuery = `
        SELECT
            u.username,
            u.profile_picture,
            p.*
        FROM
            posts p
        INNER JOIN
            users u ON p.user_id = u.id
        WHERE
            p.user_id = ?
        ORDER BY
            p.created_at DESC;
    `;

    db.query(postsQuery, [userId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: [],
            });
        }

        const postIds = result.map((post) => post.id);

        let likesQuery = `
            SELECT
                post_id,
                user_id
            FROM
                likes
            WHERE
                post_id IN (?);
        `;

        db.query(likesQuery, [postIds], (err, likesResult) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            const likeCounts = likesResult.reduce((acc, like) => {
                acc[like.post_id] = (acc[like.post_id] || 0) + 1;
                return acc;
            }, {});

            const likedPostsByCurrentUser = new Set(likesResult.map((like) => like.post_id));

            result.forEach((post) => {
                const createdAt = new Date(post.created_at);
                post.timeAgo = getTimeAgo(createdAt);
                post.like_count = likeCounts[post.id] || 0;
                post.liked_by_current_user = likedPostsByCurrentUser.has(post.id) ? 1 : 0;
            });

            if (postIds.length === 0) {
                return res.status(200).json({
                    success: true,
                    error: null,
                    data: result,
                });
            }

            let commentsQuery = `
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

            db.query(commentsQuery, [userId, postIds], (err, commentsResult) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                const commentsByPostId = commentsResult.reduce((acc, comment) => {
                    if (!acc[comment.post_id]) {
                        acc[comment.post_id] = [];
                    }
                    comment.timeAgo = getTimeAgo(new Date(comment.created_at));
                    acc[comment.post_id].push(comment);
                    return acc;
                }, {});

                result.forEach((post) => {
                    post.comment_count = commentsByPostId[post.id] ? commentsByPostId[post.id].length : 0;
                    post.comments = commentsByPostId[post.id] || [];
                });

                res.status(200).json({
                    success: true,
                    error: null,
                    data: result,
                });
            });
        });
    });
}

router.post("/like-comment", (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];
    const { commentId } = req.body;

    if (!currentUserId || !commentId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Comment ID are required.",
            data: null,
        });
    }

    const checkLikeQuery = "SELECT * FROM comment_likes WHERE user_id = ? AND comment_id = ?";

    db.query(checkLikeQuery, [currentUserId, commentId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            // Unlike comment
            const removeLikeQuery = "DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?";
            db.query(removeLikeQuery, [currentUserId, commentId], (err) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Return updated like count
                const countQuery = "SELECT COUNT(*) AS like_count FROM comment_likes WHERE comment_id = ?";
                db.query(countQuery, [commentId], (err, countResult) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    return res.status(200).json({
                        success: true,
                        message: "Comment unliked successfully.",
                        like_count: countResult[0].like_count,
                    });
                });
            });
        } else {
            // Like comment
            const addLikeQuery = "INSERT INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, NOW())";

            db.query(addLikeQuery, [currentUserId, commentId], (err) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Get comment author's user ID
                const getAuthorQuery = "SELECT user_id, post_id FROM comments WHERE id = ?";
                db.query(getAuthorQuery, [commentId], (err, commentResult) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    const commentAuthorId = commentResult[0]?.user_id;
                    const postId = commentResult[0]?.post_id;

                    if (!commentAuthorId) {
                        return res.status(404).json({
                            success: false,
                            error: "Comment not found.",
                            data: null,
                        });
                    }

                    // Don't notify if liking own comment
                    if (currentUserId === commentAuthorId) {
                        return res.status(200).json({
                            success: true,
                            message: "You liked your own comment.",
                        });
                    }

                    // Create a notification
                    const notificationMessage = `liked your comment.`;
                    createNotification(commentAuthorId, currentUserId, "comment-like", notificationMessage, postId, commentId)
                        .then(() => {
                            emitUnreadNotificationCount(commentAuthorId);
                            emitNotifications(commentAuthorId, notificationMessage);

                            const countQuery = "SELECT COUNT(*) AS like_count FROM comment_likes WHERE comment_id = ?";
                            db.query(countQuery, [commentId], (err, countResult) => {
                                if (err) {
                                    return res.status(500).json({
                                        success: false,
                                        error: err.message,
                                        data: null,
                                    });
                                }

                                return res.status(200).json({
                                    success: true,
                                    message: "Comment liked successfully.",
                                    like_count: countResult[0].like_count,
                                });
                            });
                        })
                        .catch((err) => {
                            return res.status(500).json({
                                success: false,
                                error: err.message,
                                data: null,
                            });
                        });
                });
            });
        }
    });
});

module.exports = router;

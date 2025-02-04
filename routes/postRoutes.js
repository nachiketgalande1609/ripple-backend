const express = require("express");
const db = require("../db");
const router = express.Router();
const { getTimeAgo } = require("../utils/utils");
const { createNotification } = require("../utils/utils");
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

// Fetch Home Page Posts
router.get(["/"], (req, res) => {
    const { userId } = req.params.userId ? req.params : req.query;

    let postsQuery = "SELECT u.username, u.profile_picture, p.* FROM posts p INNER JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC;";

    db.query(postsQuery, (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // Fetch like counts for each post
        const postIds = result.map((post) => post.id);

        let likesQuery = `SELECT post_id, COUNT(*) AS like_count FROM likes WHERE post_id IN (?) GROUP BY post_id;`;

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

            // If userId is provided, fetch liked posts by the current user
            if (userId) {
                let likedPostsQuery = `
                    SELECT post_id
                    FROM likes
                    WHERE user_id = ?
                    AND post_id IN (?);
                `;

                db.query(likedPostsQuery, [userId, postIds], (err, likedPostsResult) => {
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

                        // If userId is provided, check if the current user liked the post
                        post.liked_by_current_user = likedPostsByCurrentUser.has(post.id) ? 1 : 0;
                    });

                    // Fetch comments for each post
                    let commentsQuery = `
                        SELECT c.id, c.post_id, c.user_id, c.content, c.parent_comment_id, c.created_at, c.updated_at, 
                               u.username AS commenter_username, u.profile_picture AS commenter_profile_picture
                        FROM comments c
                        INNER JOIN users u ON c.user_id = u.id
                        WHERE c.post_id IN (?)
                        ORDER BY c.created_at DESC;
                    `;

                    db.query(commentsQuery, [postIds], (err, commentsResult) => {
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
                // If no userId is provided, simply return the posts with like counts
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

// Fetch Profile Page Posts
router.get(["/:userId"], (req, res) => {
    const { userId } = req.params;

    let postsQuery = "SELECT u.username, u.profile_picture, p.* FROM posts p INNER JOIN users u ON p.user_id = u.id";

    if (userId) {
        postsQuery += " WHERE p.user_id = ?";
    }

    postsQuery += " ORDER BY p.created_at DESC;";

    db.query(postsQuery, [userId].filter(Boolean), (err, result) => {
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
            SELECT post_id, user_id
            FROM likes
            WHERE post_id IN (?);
        `;

        db.query(likesQuery, [postIds, userId], (err, likesResult) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            // Create a map of post_id to like_count
            const likeCounts = likesResult.reduce((acc, like) => {
                acc[like.post_id] = (acc[like.post_id] || 0) + 1; // Increment like count
                return acc;
            }, {});

            // Create a set of post_ids that the user has liked
            const likedPostsByCurrentUser = new Set(likesResult.map((like) => like.post_id));

            // Add like count and like status to posts
            result.forEach((post) => {
                const createdAt = new Date(post.created_at);
                post.timeAgo = getTimeAgo(createdAt);

                // Set the like count
                post.like_count = likeCounts[post.id] || 0;

                // If userId is provided, check if the current user liked the post
                if (userId) {
                    post.liked_by_current_user = likedPostsByCurrentUser.has(post.id) ? 1 : 0;
                }
            });

            // If there are no post IDs, return the posts without comments
            if (postIds.length === 0) {
                return res.status(200).json({
                    success: true,
                    error: null,
                    data: result,
                });
            }

            // Fetch comments for each post
            let commentsQuery = `
                SELECT c.id, c.post_id, c.user_id, c.content, c.parent_comment_id, c.created_at, c.updated_at, u.username AS commenter_username, u.profile_picture AS commenter_profile_picture
                FROM comments c
                INNER JOIN users u ON c.user_id = u.id
                WHERE c.post_id IN (?)
                ORDER BY c.created_at DESC;
            `;

            db.query(commentsQuery, [postIds], (err, commentsResult) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Organize comments by post_id
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
    });
});

// Create Post
router.post("/", upload.single("image"), async (req, res) => {
    const { content, location, user_id } = req.body;
    const file = req.file;

    if (!content || !file) {
        return res.status(400).json({
            success: false,
            error: "Content and image are required.",
            data: null,
        });
    }

    const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: `uploads/${Date.now()}_${file.originalname}`,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: "public-read",
    };

    try {
        const command = new PutObjectCommand(uploadParams);
        await s3.send(command);

        const imageUrl = `https://${uploadParams.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadParams.Key}`;

        // Insert post into database
        const query = "INSERT INTO posts (content, image_url, location, user_id) VALUES (?, ?, ?, ?)";
        db.query(query, [content, imageUrl, location, user_id], (err, result) => {
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
                imageUrl,
            });
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
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
router.delete("/", (req, res) => {
    const { userId, postId } = req.query;

    if (!userId) {
        return res.status(400).json({
            success: false,
            error: "User ID is required to delete the post",
            data: null,
        });
    }

    const checkOwnershipQuery = "SELECT * FROM posts WHERE id = ? AND user_id = ?";

    db.query(checkOwnershipQuery, [postId, userId], (err, result) => {
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

// Like Post
router.post("/like", (req, res) => {
    const { userId, postId } = req.body;

    if (!userId || !postId) {
        return res.status(400).json({
            success: false,
            error: "User ID and Post ID are required.",
            data: null,
        });
    }

    const checkLikeQuery = "SELECT * FROM likes WHERE user_id = ? AND post_id = ?";

    db.query(checkLikeQuery, [userId, postId], (err, result) => {
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

            db.query(removeLikeQuery, [userId, postId], (err) => {
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

            db.query(addLikeQuery, [userId, postId], (err) => {
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
                    if (userId === postAuthorId) {
                        return res.status(200).json({
                            success: true,
                            message: "You liked your own post.",
                            like_count: result.length,
                        });
                    }

                    // Create a notification for the post's author
                    const notificationMessage = `liked your post.`;
                    createNotification(postAuthorId, userId, "like", notificationMessage, postId)
                        .then(() => {
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
        }
    });
});

// Comment on Post
router.post("/comment", (req, res) => {
    const { userId, postId, comment } = req.body;

    if (!userId || !postId || !comment) {
        return res.status(400).json({
            success: false,
            error: "User ID, Post ID, and Comment content are required.",
            data: null,
        });
    }

    const insertCommentQuery = "INSERT INTO comments (user_id, post_id, content, created_at) VALUES (?, ?, ?, NOW())";

    db.query(insertCommentQuery, [userId, postId, comment], (err, result) => {
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
            if (userId === postAuthorId) {
                return res.status(200).json({
                    success: true,
                    message: "You commented on your own post.",
                    commentId: result.insertId,
                });
            }

            // Create a notification for the post's author, including the comment text and comment ID
            const notificationMessage = `commented on your post: "${comment}"`; // Include the comment content in the notification
            createNotification(postAuthorId, userId, "comment", notificationMessage, postId, commentId)
                .then(() => {
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

module.exports = router;

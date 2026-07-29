const express = require("express");
const router = express.Router();
const { getTimeAgo } = require("../utils/utils");
const { createNotification } = require("../utils/utils");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  emitUnreadNotificationCount,
  emitNotifications,
} = require("../utils/utils");
const sharp = require("sharp");

const { promisePool: db } = require("../db");

// Ensure is_pinned column exists
(async () => {
  try {
    const [cols] = await db.query(
      "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'is_pinned'"
    );
    if (cols.length === 0) {
      await db.query("ALTER TABLE posts ADD COLUMN is_pinned TINYINT(1) DEFAULT 0");
    }
  } catch (e) {
    console.error("Could not ensure is_pinned column:", e.message);
  }
})();

// Ensure is_archived column exists
(async () => {
  try {
    const [cols] = await db.query(
      "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'is_archived'"
    );
    if (cols.length === 0) {
      await db.query("ALTER TABLE posts ADD COLUMN is_archived TINYINT(1) DEFAULT 0");
    }
  } catch (e) {
    console.error("Could not ensure is_archived column:", e.message);
  }
})();

// Ensure scheduled_at column exists
(async () => {
  try {
    const [cols] = await db.query(
      "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'scheduled_at'"
    );
    if (cols.length === 0) {
      await db.query("ALTER TABLE posts ADD COLUMN scheduled_at DATETIME DEFAULT NULL");
    }
  } catch (e) {
    console.error("Could not ensure scheduled_at column:", e.message);
  }
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Like Post
router.post("/like-post", async (req, res) => {
  const currentUserId = Number(req.headers["x-current-user-id"]);
  const { postId } = req.body;

  if (!currentUserId || !postId) {
    return res
      .status(400)
      .json({ success: false, error: "User ID and Post ID are required." });
  }

  try {
    const [[existingLike]] = await db.query(
      "SELECT id FROM likes WHERE user_id = ? AND post_id = ?",
      [currentUserId, postId],
    );

    if (existingLike) {
      await db.query("DELETE FROM likes WHERE user_id = ? AND post_id = ?", [
        currentUserId,
        postId,
      ]);
    } else {
      await db.query(
        "INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))",
        [currentUserId, postId],
      );

      const [[post]] = await db.query(
        "SELECT user_id FROM posts WHERE id = ?",
        [postId],
      );
      if (!post)
        return res
          .status(404)
          .json({ success: false, error: "Post not found." });

      const isOwnPost = currentUserId === post.user_id;
      if (!isOwnPost) {
        await createNotification(
          post.user_id,
          currentUserId,
          "like",
          "liked your post.",
          postId,
        );
        emitUnreadNotificationCount(post.user_id);
        // emitNotifications(post.user_id, "liked your post.");
      }
    }

    const [[{ like_count }]] = await db.query(
      "SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?",
      [postId],
    );

    return res.status(200).json({ success: true, like_count });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/submit-post-comment", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { postId, comment, parentCommentId } = req.body;

  if (!currentUserId || !postId || !comment) {
    return res.status(400).json({
      success: false,
      error: "User ID, Post ID, and Comment content are required.",
      data: null,
    });
  }

  try {
    const [insertResult] = await db.query(
      "INSERT INTO comments (user_id, post_id, content, parent_comment_id, created_at) VALUES (?, ?, ?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))",
      [currentUserId, postId, comment, parentCommentId || null],
    );

    const commentId = insertResult.insertId;

    const [postResult] = await db.query(
      "SELECT user_id FROM posts WHERE id = ?",
      [postId],
    );

    const postAuthorId = postResult[0]?.user_id;

    if (!postAuthorId) {
      return res.status(404).json({
        success: false,
        error: "Post not found.",
        data: null,
      });
    }

    // Notify parent comment author (if this is a reply and they're not the commenter)
    if (parentCommentId) {
      const [parentResult] = await db.query(
        "SELECT user_id FROM comments WHERE id = ?",
        [parentCommentId],
      );
      const parentAuthorId = parentResult[0]?.user_id;
      if (parentAuthorId && parentAuthorId != currentUserId) {
        await createNotification(
          parentAuthorId,
          currentUserId,
          "comment",
          `replied to your comment: "${comment}"`,
          postId,
          commentId,
        );
        emitUnreadNotificationCount(parentAuthorId);
      }
    }

    if (postAuthorId != currentUserId) {
      const notificationMessage = parentCommentId
        ? `replied to a comment on your post: "${comment}"`
        : `commented on your post: "${comment}"`;

      await createNotification(
        postAuthorId,
        currentUserId,
        "comment",
        notificationMessage,
        postId,
        commentId,
      );
      emitUnreadNotificationCount(postAuthorId);
    }

    // @mention notifications
    const mentionHandles = [...new Set((comment.match(/@([a-zA-Z0-9_.]+)/g) || []).map(m => m.slice(1)))];
    if (mentionHandles.length > 0) {
      const placeholders = mentionHandles.map(() => "?").join(",");
      const [mentionedUsers] = await db.query(
        `SELECT id FROM users WHERE username IN (${placeholders})`,
        mentionHandles
      );
      // Skip the commenter and anyone already notified above
      const skip = new Set([String(currentUserId), String(postAuthorId)]);
      if (parentCommentId) {
        const [pr] = await db.query("SELECT user_id FROM comments WHERE id = ?", [parentCommentId]);
        if (pr[0]?.user_id) skip.add(String(pr[0].user_id));
      }
      const preview = comment.length > 60 ? comment.slice(0, 60) + "…" : comment;
      for (const u of mentionedUsers) {
        if (!skip.has(String(u.id))) {
          await createNotification(u.id, currentUserId, "mention", `mentioned you in a comment: "${preview}"`, postId, commentId);
          emitUnreadNotificationCount(u.id);
        }
      }
    }

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
    const [commentResult] = await db.query(
      "SELECT user_id FROM comments WHERE id = ?",
      [commentId],
    );

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
    await db.query("DELETE FROM comments WHERE id = ?", [commentId]);

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
    const [checkSaved] = await db.query(
      "SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?",
      [currentUserId, postId],
    );

    if (checkSaved.length > 0) {
      // If post already saved, remove it (toggle off)
      await db.query(
        "DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?",
        [currentUserId, postId],
      );

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
      await db.query(
        "INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)",
        [currentUserId, postId],
      );

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
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = parseInt(req.query.offset) || 0;

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
            )
            AND NOT EXISTS (
                SELECT 1 FROM blocked_users b
                WHERE (b.blocker_id = ? AND b.blocked_id = p.user_id)
                   OR (b.blocker_id = p.user_id AND b.blocked_id = ?)
            )
            AND (p.is_archived = 0 OR p.is_archived IS NULL)
            AND (p.scheduled_at IS NULL OR p.scheduled_at <= NOW())
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?;
        `;

    const [postsResult] = await db.query(postsQuery, [userId, userId, userId, userId, limit, offset]);
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
    const [likesResult] = await db.query(likesQuery, [postIds]);

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
      const [likedPostsResult] = await db.query(likedPostsQuery, [
        userId,
        postIds,
      ]);
      likedPostsByCurrentUser = new Set(
        likedPostsResult.map((like) => like.post_id),
      );
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
    const [commentsResult] = await db.query(commentsQuery, [userId, postIds]);

    // Organize comments by post_id
    const commentsByPostId = commentsResult.reduce((acc, comment) => {
      if (!acc[comment.post_id]) acc[comment.post_id] = [];
      comment.timeAgo = getTimeAgo(new Date(comment.created_at));
      comment.likes_count = Number(comment.likes_count) || 0;
      comment.liked_by_user = Boolean(comment.liked_by_user);
      acc[comment.post_id].push(comment);
      return acc;
    }, {});

    // Tagged users per post
    const [taggedRows] = await db.query(
      `SELECT pt.post_id, u.id, u.username, u.profile_picture
       FROM post_tags pt JOIN users u ON u.id = pt.tagged_user_id
       WHERE pt.post_id IN (?)`,
      [postIds],
    );
    const taggedByPostId = taggedRows.reduce((acc, row) => {
      if (!acc[row.post_id]) acc[row.post_id] = [];
      acc[row.post_id].push({ id: row.id, username: row.username, profile_picture: row.profile_picture });
      return acc;
    }, {});

    // Carousel media per post
    const [mediaRows] = await db.query(
      `SELECT post_id, file_url, media_order FROM post_media WHERE post_id IN (?) ORDER BY media_order ASC`,
      [postIds],
    );
    const mediaByPostId = mediaRows.reduce((acc, row) => {
      if (!acc[row.post_id]) acc[row.post_id] = [];
      acc[row.post_id].push(row.file_url);
      return acc;
    }, {});

    // Repost counts
    const [repostCountsResult] = await db.query(
      `SELECT post_id, COUNT(*) AS repost_count FROM reposts WHERE post_id IN (?) GROUP BY post_id`,
      [postIds]
    );
    const repostCounts = repostCountsResult.reduce((acc, r) => {
      acc[r.post_id] = r.repost_count;
      return acc;
    }, {});

    let repostedSet = new Set();
    if (userId) {
      const [repostedByUser] = await db.query(
        `SELECT post_id FROM reposts WHERE user_id = ? AND post_id IN (?)`,
        [userId, postIds]
      );
      repostedSet = new Set(repostedByUser.map((r) => r.post_id));
    }

    // Finalizing post objects
    const finalPosts = postsResult.map((post) => {
      return {
        ...post,
        timeAgo: getTimeAgo(new Date(post.created_at)),
        like_count: likeCounts[post.id] || 0,
        liked_by_current_user: likedPostsByCurrentUser.has(post.id) ? 1 : 0,
        comment_count: commentsByPostId[post.id]?.length || 0,
        comments: commentsByPostId[post.id] || [],
        tagged_users: taggedByPostId[post.id] || [],
        media_files: mediaByPostId[post.id] || [],
        repost_count: repostCounts[post.id] || 0,
        is_reposted: repostedSet.has(post.id) ? 1 : 0,
      };
    });

    return res.status(200).json({
      success: true,
      error: null,
      data: finalPosts,
      hasMore: finalPosts.length === limit,
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
  const limit = Math.min(parseInt(req.query.limit) || 9, 50);
  const offset = parseInt(req.query.offset) || 0;

  try {
    // Check if the user exists and is private
    const privacyQuery = `SELECT is_private FROM users WHERE id = ?;`;
    const [userResult] = await db.query(privacyQuery, [userId]);

    if (userResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: "User not found",
        data: null,
      });
    }

    const isPrivate = userResult[0].is_private; // ✅ FIX

    if (isPrivate && currentUserId != userId) {
      const followCheckQuery = `
                SELECT 1 
                FROM followers 
                WHERE follower_id = ? AND following_id = ?;
            `;
      const [followResult] = await db.query(followCheckQuery, [
        currentUserId,
        userId,
      ]);

      if (followResult.length === 0) {
        return res.status(403).json({
          success: false,
          error:
            "This account is private. You must follow the user to see their posts.",
          data: null,
        });
      }
    }

    // Fetch posts if public or following
    await fetchPosts(userId, res, limit, offset);
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
    const [userResult] = await db.query(privacyQuery, [userId]);

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
      const [followResult] = await db.query(followCheckQuery, [
        currentUserId,
        userId,
      ]);

      if (followResult.length === 0) {
        return res.status(403).json({
          success: false,
          error:
            "This account is private. You must follow the user to see their posts.",
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
router.post("/create-post", upload.array("images", 10), async (req, res) => {
  const { content, location, user_id, scheduled_at } = req.body;
  const files = req.files;

  if (!content || !files || files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Content and a photo or video are required.",
      data: null,
    });
  }

  // Helper: upload a single file buffer to S3, return URL
  async function uploadFileToS3(file) {
    const fileType = file.mimetype;
    let buffer = file.buffer;
    let mediaWidth = null;
    let mediaHeight = null;

    if (fileType.startsWith("image/")) {
      const image = sharp(file.buffer).resize({ width: 1080 });
      buffer = await image.toBuffer();
      const metadata = await sharp(buffer).metadata();
      mediaWidth = metadata.width;
      mediaHeight = metadata.height;
    }

    const key = `uploads/${Date.now()}_${Math.random().toString(36).slice(2)}_${file.originalname}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: fileType,
      ACL: "public-read",
    }));

    return {
      url: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
      mediaWidth,
      mediaHeight,
    };
  }

  try {
    // Upload all files in parallel
    const uploaded = await Promise.all(files.map(uploadFileToS3));

    const firstFile = uploaded[0];

    const scheduledAt = scheduled_at ? new Date(scheduled_at) : null;

    const insertQuery = `
            INSERT INTO posts (content, file_url, location, user_id, media_width, media_height, scheduled_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

    const [result] = await db.query(insertQuery, [
      content,
      firstFile.url,
      location,
      user_id,
      firstFile.mediaWidth,
      firstFile.mediaHeight,
      scheduledAt,
    ]);

    const postId = result.insertId;

    // Store all media in post_media (including first for consistency)
    if (uploaded.length > 1) {
      const mediaValues = uploaded.map((u, i) => [postId, u.url, i, u.mediaWidth, u.mediaHeight]);
      await db.query(
        "INSERT INTO post_media (post_id, file_url, media_order, media_width, media_height) VALUES ?",
        [mediaValues]
      );
    }

    await saveHashtags(postId, content);

    // Handle tagged users
    let taggedUsers = [];
    try { taggedUsers = req.body.taggedUsers ? JSON.parse(req.body.taggedUsers) : []; } catch {}
    for (const taggedUserId of taggedUsers) {
      await db.query(
        "INSERT IGNORE INTO post_tags (post_id, tagged_user_id) VALUES (?, ?)",
        [postId, taggedUserId]
      );
      if (taggedUserId != user_id) {
        await createNotification(taggedUserId, user_id, "tag", "tagged you in a post", postId, null);
        emitUnreadNotificationCount(taggedUserId);
      }
    }

    return res.status(201).json({
      success: true,
      error: null,
      message: "Post created successfully",
      postId,
      fileUrl: firstFile.url,
      mediaWidth: firstFile.mediaWidth,
      mediaHeight: firstFile.mediaHeight,
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
router.post("/update-post", async (req, res) => {
  const { postId, content } = req.body;

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
    const [result] = await db.query(query, values);

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

  const checkOwnershipQuery =
    "SELECT * FROM posts WHERE id = ? AND user_id = ?";

  try {
    const [result] = await db.query(checkOwnershipQuery, [
      postId,
      currentUserId,
    ]);

    if (result.length === 0) {
      return res.status(403).json({
        success: false,
        error: "You can only delete your own posts",
        data: null,
      });
    }

    const deleteQuery = "DELETE FROM posts WHERE id = ?";
    await db.query(deleteQuery, [postId]);

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
    const [result] = await db.query(savedPostsQuery, [currentUserId]);

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
    const [likesResult] = await db.query(likesQuery, [postIds]);

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
    const [likedPostsResult] = currentUserId
      ? await db.query(likedPostsQuery, [currentUserId, postIds])
      : [];

    const likedPostsByCurrentUser = new Set(
      likedPostsResult.map((like) => like.post_id),
    );

    // Fetch repost counts for all posts
    const [repostCountsResult] = await db.query(
      `SELECT post_id, COUNT(*) AS repost_count FROM reposts WHERE post_id IN (?) GROUP BY post_id`,
      [postIds]
    );
    const repostCounts = repostCountsResult.reduce((acc, r) => {
      acc[r.post_id] = r.repost_count;
      return acc;
    }, {});

    // Fetch which posts current user has reposted
    const [repostedByUser] = currentUserId
      ? await db.query(`SELECT post_id FROM reposts WHERE user_id = ? AND post_id IN (?)`, [currentUserId, postIds])
      : [[]];
    const repostedSet = new Set(repostedByUser.map((r) => r.post_id));

    // Add like count and like status to posts
    result.forEach((post) => {
      const createdAt = new Date(post.created_at);
      post.timeAgo = getTimeAgo(createdAt);

      // Set the like count
      post.like_count = likeCounts[post.id] || 0;

      // If currentUserId is provided, check if the current user liked the post
      post.liked_by_current_user = likedPostsByCurrentUser.has(post.id) ? 1 : 0;

      // Repost data
      post.repost_count = repostCounts[post.id] || 0;
      post.is_reposted = repostedSet.has(post.id) ? 1 : 0;
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
    const [commentsResult] = await db.query(commentsQuery, [
      currentUserId,
      postIds,
    ]);

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
      post.comment_count = commentsByPostId[post.id]
        ? commentsByPostId[post.id].length
        : 0; // Add comment count
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
    const [existingLike] = await db.query(
      "SELECT * FROM comment_likes WHERE user_id = ? AND comment_id = ?",
      [currentUserId, commentId],
    );

    if (existingLike.length > 0) {
      // Unlike
      await db.query(
        "DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?",
        [currentUserId, commentId],
      );

      const [countResult] = await db.query(
        "SELECT COUNT(*) AS like_count FROM comment_likes WHERE comment_id = ?",
        [commentId],
      );

      return res.status(200).json({
        success: true,
        message: "Comment unliked successfully.",
        like_count: countResult[0].like_count,
      });
    } else {
      // Like
      await db.query(
        "INSERT INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))",
        [currentUserId, commentId],
      );

      const [commentResult] = await db.query(
        "SELECT user_id, post_id FROM comments WHERE id = ?",
        [commentId],
      );

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

      if (currentUserId != commentAuthorId) {
        const notificationMessage = "liked your comment.";

        await createNotification(
          commentAuthorId,
          currentUserId,
          "comment_like",
          notificationMessage,
          postId,
          commentId,
        );
        emitUnreadNotificationCount(commentAuthorId);
        emitNotifications(commentAuthorId, notificationMessage);
      }

      const [countResult] = await db.query(
        "SELECT COUNT(*) AS like_count FROM comment_likes WHERE comment_id = ?",
        [commentId],
      );

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

/* ── Fetch tagged posts for a user ── */
router.get("/fetch-tagged-posts/:userId", async (req, res) => {
  const { userId } = req.params;
  const currentUserId = req.headers["x-current-user-id"];
  const limit = parseInt(req.query.limit) || 12;
  const offset = parseInt(req.query.offset) || 0;
  try {
    const [posts] = await db.query(
      `SELECT p.id, p.file_url, p.content, p.location, p.created_at,
              p.media_width, p.media_height,
              u.username, u.profile_picture,
              (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likes_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comments_count,
              EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) AS liked_by_current_user,
              EXISTS(SELECT 1 FROM saved_posts WHERE post_id = p.id AND user_id = ?) AS saved_by_current_user
       FROM post_tags pt
       JOIN posts p ON p.id = pt.post_id
       JOIN users u ON u.id = p.user_id
       WHERE pt.tagged_user_id = ?
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [currentUserId, currentUserId, userId, limit, offset]
    );
    const [[{ total }]] = await db.query(
      "SELECT COUNT(*) AS total FROM post_tags WHERE tagged_user_id = ?",
      [userId]
    );
    return res.json({ success: true, data: posts, hasMore: offset + posts.length < total });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function fetchPosts(userId, res, limit = 9, offset = 0) {
  try {
    const postsQuery = `
            SELECT
                p.id,
                p.file_url
            FROM
                posts p
            WHERE
                p.user_id = ?
                AND (p.file_url IS NULL OR p.file_url NOT REGEXP '\\.(mp4|mov|webm|ogg)$')
                AND (p.is_archived = 0 OR p.is_archived IS NULL)
                AND (p.scheduled_at IS NULL OR p.scheduled_at <= NOW())
            ORDER BY
                p.created_at DESC
            LIMIT ? OFFSET ?;
        `;

    const [result] = await db.query(postsQuery, [userId, limit, offset]);

    return res.status(200).json({
      success: true,
      error: null,
      data: result,
      hasMore: result.length === limit,
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
                p.user_id,
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

    const [result] = await db.query(postQuery, [postId, userId]);

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

    const [likesResult] = await db.query(likesQuery, [postId]);
    const likeCount = likesResult.length;

    const likedByCurrentUser = likesResult.some(
      (like) => like.user_id == currentUserId,
    );

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

    const [commentsResult] = await db.query(commentsQuery, [
      currentUserId,
      postId,
    ]);

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

// GET /reels?offset=0&limit=10&userId=X — fetch video posts for the Reels feed
router.get("/reels", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = parseInt(req.query.offset) || 0;
  const filterUserId = req.query.userId ? parseInt(req.query.userId) : null;

  try {
    const reelsQuery = `
      SELECT
        p.*,
        u.username,
        u.profile_picture,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
        IF((SELECT COUNT(*) FROM likes WHERE user_id = ? AND post_id = p.id) > 0, 1, 0) AS liked_by_current_user,
        (SELECT COUNT(*) FROM reposts WHERE post_id = p.id) AS repost_count,
        IF((SELECT COUNT(*) FROM reposts WHERE user_id = ? AND post_id = p.id) > 0, 1, 0) AS is_reposted,
        IF((SELECT COUNT(*) FROM saved_posts WHERE user_id = ? AND post_id = p.id) > 0, 1, 0) AS saved_by_current_user,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
        (SELECT COUNT(*) FROM reel_views WHERE post_id = p.id) AS view_count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.file_url REGEXP '\\\\.(mp4|mov|webm|ogg)$'
      ${filterUserId ? "AND p.user_id = ?" : ""}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const params = [currentUserId, currentUserId, currentUserId];
    if (filterUserId) params.push(filterUserId);
    params.push(limit, offset);

    const [rows] = await db.query(reelsQuery, params);

    const data = rows.map((row) => ({
      ...row,
      timeAgo: getTimeAgo(new Date(row.created_at)),
    }));

    return res.status(200).json({
      success: true,
      error: null,
      data,
      hasMore: data.length === limit,
    });
  } catch (err) {
    console.error("Error fetching reels:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      data: null,
    });
  }
});

// GET pinned posts for a user profile
router.get("/pinned/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const [posts] = await db.query(
      `SELECT id, file_url FROM posts
       WHERE user_id = ? AND is_pinned = 1
         AND (file_url IS NULL OR file_url NOT REGEXP '\\.(mp4|mov|webm|ogg)$')
       ORDER BY updated_at DESC`,
      [userId]
    );
    res.json({ success: true, data: posts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ARCHIVE a post
router.put("/archive/:postId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { postId } = req.params;
  if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const [rows] = await db.query("SELECT user_id FROM posts WHERE id = ?", [postId]);
    if (!rows.length || String(rows[0].user_id) !== String(currentUserId)) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    await db.query("UPDATE posts SET is_archived = 1, is_pinned = 0 WHERE id = ?", [postId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UNARCHIVE a post
router.put("/unarchive/:postId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { postId } = req.params;
  if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    await db.query("UPDATE posts SET is_archived = 0 WHERE id = ? AND user_id = ?", [postId, currentUserId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PIN a post
router.put("/pin/:postId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { postId } = req.params;
  if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const [rows] = await db.query("SELECT user_id FROM posts WHERE id = ?", [postId]);
    if (!rows.length || String(rows[0].user_id) !== String(currentUserId)) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    const [[{ count }]] = await db.query(
      "SELECT COUNT(*) AS count FROM posts WHERE user_id = ? AND is_pinned = 1",
      [currentUserId]
    );
    if (count >= 3) {
      return res.status(400).json({ success: false, error: "max_pins_reached" });
    }
    await db.query("UPDATE posts SET is_pinned = 1 WHERE id = ?", [postId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UNPIN a post
router.put("/unpin/:postId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { postId } = req.params;
  if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    await db.query("UPDATE posts SET is_pinned = 0 WHERE id = ? AND user_id = ?", [postId, currentUserId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET scheduled posts for current user
router.get("/scheduled", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.file_url, p.content, p.scheduled_at, p.media_width, p.media_height
       FROM posts p
       WHERE p.user_id = ? AND p.scheduled_at > NOW()
       ORDER BY p.scheduled_at ASC`,
      [currentUserId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET archived posts for current user
router.get("/archived", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  if (!currentUserId) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const [rows] = await db.query(
      "SELECT id, file_url, content, created_at FROM posts WHERE user_id = ? AND is_archived = 1 ORDER BY created_at DESC",
      [currentUserId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/:postId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { postId } = req.params;

  try {
    // 1. Get post + user
    const [postResult] = await db.query(
      `
            SELECT 
                p.*, 
                u.username, 
                u.profile_picture, 
                u.is_private
            FROM posts p
            JOIN users u ON p.user_id = u.id
            WHERE p.id = ?
        `,
      [postId],
    );

    if (postResult.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Post not found",
        data: null,
      });
    }

    const post = postResult[0];

    // 2. Privacy check
    if (post.is_private && currentUserId != post.user_id) {
      const [follow] = await db.query(
        `SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ?`,
        [currentUserId, post.user_id],
      );

      if (follow.length === 0) {
        return res.status(403).json({
          success: false,
          error: "Private account",
          data: null,
        });
      }
    }

    // 3. Likes
    const [[{ like_count }]] = await db.query(
      `SELECT COUNT(*) AS like_count FROM likes WHERE post_id = ?`,
      [postId],
    );

    const [liked] = await db.query(
      `SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?`,
      [currentUserId, postId],
    );

    // 4. Saved
    const [saved] = await db.query(
      `SELECT 1 FROM saved_posts WHERE user_id = ? AND post_id = ?`,
      [currentUserId, postId],
    );

    // 5. Comments
    const [comments] = await db.query(
      `
            SELECT 
                c.*,
                u.username AS commenter_username,
                u.profile_picture AS commenter_profile_picture,
                COUNT(cl.id) AS likes_count,
                MAX(CASE WHEN cl.user_id = ? THEN 1 ELSE 0 END) AS liked_by_user
            FROM comments c
            JOIN users u ON c.user_id = u.id
            LEFT JOIN comment_likes cl ON cl.comment_id = c.id
            WHERE c.post_id = ?
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `,
      [currentUserId, postId],
    );

    comments.forEach((c) => {
      c.timeAgo = getTimeAgo(new Date(c.created_at));
    });

    // 6. Tagged users
    const [taggedUsers] = await db.query(
      `SELECT u.id, u.username, u.profile_picture
       FROM post_tags pt JOIN users u ON u.id = pt.tagged_user_id
       WHERE pt.post_id = ?`,
      [postId],
    );

    // 7. Carousel media
    const [mediaRows] = await db.query(
      `SELECT file_url FROM post_media WHERE post_id = ? ORDER BY media_order ASC`,
      [postId],
    );
    const media_files = mediaRows.map((r) => r.file_url);

    // 8. Final response
    return res.status(200).json({
      success: true,
      error: null,
      data: {
        ...post,
        like_count,
        liked_by_current_user: liked.length > 0 ? 1 : 0,
        saved_by_current_user: saved.length > 0 ? 1 : 0,
        comment_count: comments.length,
        comments,
        tagged_users: taggedUsers,
        media_files,
        timeAgo: getTimeAgo(new Date(post.created_at)),
      },
    });
  } catch (err) {
    console.error("Error fetching post:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      data: null,
    });
  }
});

/* ── Update post tags ── */
router.put("/update-tags/:postId", async (req, res) => {
  const { postId } = req.params;
  const { taggedUsers = [] } = req.body; // array of user ids
  const currentUserId = req.headers["x-current-user-id"];
  try {
    // verify ownership
    const [[post]] = await db.query("SELECT user_id FROM posts WHERE id = ?", [postId]);
    if (!post || post.user_id != currentUserId)
      return res.status(403).json({ success: false, error: "Not authorized" });

    // get existing tags to diff
    const [existing] = await db.query("SELECT tagged_user_id FROM post_tags WHERE post_id = ?", [postId]);
    const existingIds = existing.map((r) => r.tagged_user_id);
    const toAdd = taggedUsers.filter((id) => !existingIds.includes(id));
    const toRemove = existingIds.filter((id) => !taggedUsers.includes(id));

    console.log("[update-tags] existingIds:", existingIds, "toAdd:", toAdd, "toRemove:", toRemove);
    for (const uid of toAdd) {
      await db.query("INSERT IGNORE INTO post_tags (post_id, tagged_user_id) VALUES (?, ?)", [postId, uid]);
      console.log("[update-tags] uid:", uid, "currentUserId:", currentUserId, "same?", uid == currentUserId);
      if (uid != currentUserId) {
        const notifResult = await createNotification(uid, currentUserId, "tag", "tagged you in a post", postId, null);
        console.log("[update-tags] notification created:", notifResult?.insertId);
        emitUnreadNotificationCount(uid);
      }
    }
    for (const uid of toRemove) {
      await db.query("DELETE FROM post_tags WHERE post_id = ? AND tagged_user_id = ?", [postId, uid]);
    }

    const [updated] = await db.query(
      `SELECT u.id, u.username, u.profile_picture FROM post_tags pt JOIN users u ON u.id = pt.tagged_user_id WHERE pt.post_id = ?`,
      [postId],
    );
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("[update-tags] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Repost routes ───────────────────────────────────────────

// Ensure reel_views table exists
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS reel_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        viewer_id INT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      )
    `);
  } catch (err) {
    console.error("Error creating reel_views table:", err.message);
  }
})();

// POST /reels/:postId/view — record a reel view
router.post("/reels/:postId/view", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"] || null;
  const { postId } = req.params;
  try {
    await db.query(
      `INSERT INTO reel_views (post_id, viewer_id) VALUES (?, ?)`,
      [postId, currentUserId || null]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Ensure reposts table exists
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS reposts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        post_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_repost (user_id, post_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      )
    `);
  } catch (err) {
    console.error("Error creating reposts table:", err.message);
  }
})();

// POST /repost/:postId — repost a post
router.post("/repost/:postId", async (req, res) => {
  const currentUserId = Number(req.headers["x-current-user-id"]);
  const { postId } = req.params;

  if (!currentUserId || !postId) {
    return res.status(400).json({ success: false, error: "User ID and Post ID are required." });
  }

  try {
    await db.query(
      "INSERT IGNORE INTO reposts (user_id, post_id, created_at) VALUES (?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))",
      [currentUserId, postId]
    );
    const [[{ repost_count }]] = await db.query(
      "SELECT COUNT(*) AS repost_count FROM reposts WHERE post_id = ?",
      [postId]
    );
    return res.status(200).json({ success: true, repost_count });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /repost/:postId — undo repost
router.delete("/repost/:postId", async (req, res) => {
  const currentUserId = Number(req.headers["x-current-user-id"]);
  const { postId } = req.params;

  if (!currentUserId || !postId) {
    return res.status(400).json({ success: false, error: "User ID and Post ID are required." });
  }

  try {
    await db.query(
      "DELETE FROM reposts WHERE user_id = ? AND post_id = ?",
      [currentUserId, postId]
    );
    const [[{ repost_count }]] = await db.query(
      "SELECT COUNT(*) AS repost_count FROM reposts WHERE post_id = ?",
      [postId]
    );
    return res.status(200).json({ success: true, repost_count });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /reposts/user/:userId — get all posts reposted by a user
router.get("/reposts/user/:userId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { userId } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT p.*, u.username, u.profile_picture,
              r.created_at AS repost_created_at,
              (SELECT COUNT(*) FROM reposts WHERE post_id = p.id) AS repost_count,
              IF((SELECT COUNT(*) FROM reposts WHERE user_id = ? AND post_id = p.id) > 0, 1, 0) AS is_reposted,
              (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
              IF((SELECT COUNT(*) FROM likes WHERE user_id = ? AND post_id = p.id) > 0, 1, 0) AS liked_by_current_user,
              IF((SELECT COUNT(*) FROM saved_posts WHERE user_id = ? AND post_id = p.id) > 0, 1, 0) AS saved_by_current_user
       FROM reposts r
       JOIN posts p ON p.id = r.post_id
       JOIN users u ON u.id = p.user_id
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC`,
      [currentUserId, currentUserId, currentUserId, userId]
    );

    const result = rows.map((row) => ({
      ...row,
      timeAgo: getTimeAgo(new Date(row.created_at)),
      repost_timeAgo: getTimeAgo(new Date(row.repost_created_at)),
      comments: [],
      comment_count: 0,
      tagged_users: [],
      media_files: [],
    }));

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Hashtag helper ──────────────────────────────────────────
function extractHashtags(text) {
  const matches = text.match(/#([a-zA-Z0-9_]+)/g) || [];
  return [...new Set(matches.map((t) => t.slice(1).toLowerCase()))];
}

async function saveHashtags(postId, content) {
  const tags = extractHashtags(content);
  if (!tags.length) return;

  for (const tag of tags) {
    // Upsert the hashtag
    await db.query(
      `INSERT INTO hashtags (tag) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [tag],
    );
    const [[{ id: hashtagId }]] = await db.query(
      `SELECT id FROM hashtags WHERE tag = ?`,
      [tag],
    );
    // Link to post (ignore if already linked)
    await db.query(
      `INSERT IGNORE INTO post_hashtags (post_id, hashtag_id) VALUES (?, ?)`,
      [postId, hashtagId],
    );
  }
}

module.exports = router;

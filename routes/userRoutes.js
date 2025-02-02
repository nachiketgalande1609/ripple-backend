const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const router = express.Router();

const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client("702353220748-2lmc03lb4tcfnuqds67h8bbupmb1aa0q.apps.googleusercontent.com");

router.post("/register", async (req, res) => {
    const { email, username, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const checkUserQuery = "SELECT * FROM users WHERE email = ? OR username = ?";
    db.query(checkUserQuery, [email, username], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            const existingUser = result[0];
            if (existingUser.email === email) {
                return res.status(400).json({
                    success: false,
                    error: "User with the same email already exist.",
                    data: null,
                });
            }
            if (existingUser.username === username) {
                return res.status(400).json({
                    success: false,
                    error: "Username already taken.",
                    data: null,
                });
            }
        }

        const insertQuery = "INSERT INTO users (username, email, password) VALUES (?, ?, ?)";
        db.query(insertQuery, [username, email, hashedPassword], (err, result) => {
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
                data: {
                    message: "User registered successfully",
                },
            });
        });
    });
});

// Login user
router.post("/login", (req, res) => {
    const { email, password } = req.body;

    const query = "SELECT id, username, email, password, profile_picture FROM users WHERE email = ?";

    db.query(query, [email], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({
                success: false,
                error: "Invalid credentials",
                data: null,
            });
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });

        res.json({
            success: true,
            error: null,
            data: {
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    profile_picture_url: user.profile_picture,
                },
            },
        });
    });
});

router.post("/google-login", async (req, res) => {
    const { token } = req.body;

    try {
        // Verify the Google ID token
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const { email, given_name: firstName, family_name: lastName } = payload;

        // Check if the user already exists in your database
        const query = "SELECT id, username, email, profile_picture FROM users WHERE email = ?";
        db.query(query, [email], async (err, results) => {
            if (err) {
                console.error("Database error:", err);
                return res.status(500).json({
                    success: false,
                    error: "Database error",
                    data: null,
                });
            }

            let user = results[0];

            if (!user) {
                // Create a new user if they don't exist
                const username = email.split("@")[0]; // Generate a username from email
                const insertQuery = `
                    INSERT INTO users (username, email, first_name, last_name, profile_picture, created_at, password)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                const insertValues = [username, email, firstName, lastName, payload.picture, new Date(), null];

                db.query(insertQuery, insertValues, (err, results) => {
                    if (err) {
                        console.error("Error creating user:", err);
                        return res.status(500).json({
                            success: false,
                            error: "Error creating user",
                            data: null,
                        });
                    }

                    const newUserId = results.insertId;
                    db.query("SELECT id, username, email, profile_picture FROM users WHERE id = ?", [newUserId], (err, results) => {
                        if (err || results.length === 0) {
                            console.error("Error fetching new user:", err);
                            return res.status(500).json({
                                success: false,
                                error: "Error fetching new user",
                                data: null,
                            });
                        }

                        user = results[0];
                        sendResponse(user, res);
                    });
                });
            } else {
                // User exists, send response
                sendResponse(user, res);
            }
        });
    } catch (error) {
        console.error("Error during Google login:", error);
        return res.status(401).json({
            success: false,
            error: "Invalid Google token or authentication failed",
            data: null,
        });
    }
});

// Helper function to send the response
const sendResponse = (user, res) => {
    const token = jwt.sign(
        {
            id: user.id,
            email: user.email,
            username: user.username,
        },
        process.env.JWT_SECRET || "secret123",
        { expiresIn: "1h" } // Token expiration time
    );

    // Return success response with user details and token
    return res.json({
        success: true,
        error: null,
        data: {
            token: token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                profile_picture_url: user.profile_picture,
            },
        },
    });
};

router.get("/profile/:userId", (req, res) => {
    const { userId } = req.params;
    const { currentUserId } = req.query; // Assuming current user ID is passed in query params

    const userQuery = "SELECT id, username, email, bio, profile_picture FROM users WHERE id = ?";

    db.query(userQuery, [userId], (err, userResults) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (userResults.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = userResults[0];

        const postCountQuery = "SELECT COUNT(id) AS posts_count FROM posts WHERE user_id = ?";
        const followersCountQuery = "SELECT COUNT(*) AS followers_count FROM followers WHERE following_id = ?";
        const followingCountQuery = "SELECT COUNT(*) AS following_count FROM followers WHERE follower_id = ?";
        const followingQuery = "SELECT 1 FROM followers WHERE follower_id = ? AND following_id = ? LIMIT 1";

        db.query(postCountQuery, [userId], (err, postResults) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            const postsCount = postResults[0].posts_count || 0;

            db.query(followersCountQuery, [userId], (err, followersResults) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                const followersCount = followersResults[0].followers_count || 0;

                db.query(followingCountQuery, [userId], (err, followingResults) => {
                    if (err) {
                        return res.status(500).json({
                            success: false,
                            error: err.message,
                            data: null,
                        });
                    }

                    const followingCount = followingResults[0].following_count || 0;

                    // Check if the current user follows the profile user
                    if (!currentUserId) {
                        return res.status(200).json({
                            success: true,
                            error: null,
                            data: {
                                id: user.id,
                                username: user.username,
                                email: user.email,
                                bio: user.bio,
                                profile_picture: user.profile_picture,
                                posts_count: postsCount,
                                followers_count: followersCount,
                                following_count: followingCount,
                                is_following: false, // If currentUserId is not provided, assume not following
                            },
                        });
                    }

                    db.query(followingQuery, [currentUserId, userId], (err, followResults) => {
                        if (err) {
                            return res.status(500).json({
                                success: false,
                                error: err.message,
                                data: null,
                            });
                        }

                        const isFollowing = followResults.length > 0;

                        res.status(200).json({
                            success: true,
                            error: null,
                            data: {
                                id: user.id,
                                username: user.username,
                                email: user.email,
                                bio: user.bio,
                                profile_picture: user.profile_picture,
                                posts_count: postsCount,
                                followers_count: followersCount,
                                following_count: followingCount,
                                is_following: isFollowing, // New field to indicate if the current user follows this user
                            },
                        });
                    });
                });
            });
        });
    });
});

// Follow user
router.post("/follow", async (req, res) => {
    const { followerId, followingId } = req.body;

    // Input validation
    if (!followerId || !followingId) {
        return res.status(400).json({
            success: false,
            error: "Follower and following user IDs are required.",
            data: null,
        });
    }

    if (followerId === followingId) {
        return res.status(400).json({
            success: false,
            error: "You cannot follow yourself.",
            data: null,
        });
    }

    // Check if the follow relationship already exists
    const checkFollowQuery = "SELECT * FROM followers WHERE follower_id = ? AND following_id = ?";
    db.query(checkFollowQuery, [followerId, followingId], (err, result) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (result.length > 0) {
            return res.status(400).json({
                success: false,
                error: "You are already following this user.",
                data: null,
            });
        }

        // Insert the follow relationship
        const insertFollowQuery = "INSERT INTO followers (follower_id, following_id) VALUES (?, ?)";
        db.query(insertFollowQuery, [followerId, followingId], (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            // Create a notification for the follow action
            const notificationMessage = `started following you.`;
            const insertNotificationQuery = `
                INSERT INTO notifications (user_id, sender_id, type, message, created_at)
                VALUES (?, ?, 'follow', ?, NOW());
            `;

            db.query(insertNotificationQuery, [followingId, followerId, notificationMessage], (err, result) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message,
                        data: null,
                    });
                }

                // Success response
                res.status(201).json({
                    success: true,
                    error: null,
                    data: {
                        message: `User ${followerId} is now following user ${followingId}`,
                        notification: {
                            id: result.insertId,
                            message: notificationMessage,
                        },
                    },
                });
            });
        });
    });
});

router.get("/search", (req, res) => {
    const { searchString } = req.query; // Extract search string from query parameters

    if (!searchString || searchString.trim().length === 0) {
        return res.status(400).json({
            success: false,
            error: "Search string is required.",
            data: null,
        });
    }

    const searchQuery = `
        SELECT id, username, email, profile_picture 
        FROM users 
        WHERE username LIKE ? 
        LIMIT 10`; // Limits to 10 results for performance

    // Use '%' on both sides for partial matching
    db.query(searchQuery, [`%${searchString}%`], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // If no results found
        if (results.length === 0) {
            return res.status(200).json({
                success: true,
                error: null,
                data: {
                    message: "No users found.",
                    users: [],
                },
            });
        }

        res.status(200).json({
            success: true,
            error: null,
            data: {
                users: results,
            },
        });
    });
});

router.get("/chat/:userId", (req, res) => {
    const { userId } = req.params;

    const userQuery = "SELECT id, username, profile_picture FROM users WHERE id = ?";

    db.query(userQuery, [userId], (err, userResults) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        if (userResults.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = userResults[0];

        res.status(200).json({
            success: true,
            error: null,
            data: {
                id: user.id,
                username: user.username,
                profile_picture: user.profile_picture,
            },
        });
    });
});

module.exports = router;

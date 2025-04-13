const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const router = express.Router();
const { sendEmail } = require("../utils/mailer");

const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client("702353220748-2lmc03lb4tcfnuqds67h8bbupmb1aa0q.apps.googleusercontent.com");

router.post("/register", async (req, res) => {
    const { email, username, password } = req.body;

    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (username && !usernameRegex.test(username)) {
        return res.status(400).json({
            success: false,
            error: "Invalid 'username'. It can only contain letters, numbers, and underscores.",
            data: null,
        });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Check if the user already exists
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
                    error: "User with the same email already exists.",
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

        const verificationToken = jwt.sign({ email }, process.env.JWT_SECRET, {
            expiresIn: "1h",
        });

        const tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

        const insertQuery = `
            INSERT INTO users (username, email, password, verification_token, token_expiry, is_verified)
            VALUES (?, ?, ?, ?, ?, NULL)
        `;

        db.query(insertQuery, [username, email, hashedPassword, verificationToken, tokenExpiry], async (err, result) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message,
                    data: null,
                });
            }

            const verificationLink = `${process.env.FRONTEND_URL}/verify-account?token=${verificationToken}`;

            await sendEmail(
                email,
                "Verify your account",
                `Click the link to verify your account: ${verificationLink}`,
                `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
                    <h2 style="color: #333;">Welcome to Ripple, ${username}!</h2>
                    <p style="font-size: 16px; color: #555;">
                        Thank you for registering. Please verify your email address to activate your account.
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${verificationLink}" style="background-color: #4CAF50; color: white; padding: 12px 25px; text-decoration: none; font-size: 16px; border-radius: 5px;">
                            Verify Account
                        </a>
                    </div>
                    <p style="font-size: 14px; color: #999;">
                        If the button above doesn't work, copy and paste the following link into your browser:
                    </p>
                    <p style="font-size: 14px; color: #007bff; word-break: break-all;">${verificationLink}</p>
                    <p style="font-size: 14px; color: #999;">
                        This link will expire in 1 hour.
                    </p>
                    <p style="font-size: 14px; color: #bbb; border-top: 1px solid #eee; padding-top: 15px;">
                        If you didn’t create this account, you can safely ignore this email.
                    </p>
                </div>
                `
            );

            return res.status(201).json({
                success: true,
                error: null,
                data: {
                    message: "User registered successfully. Please check your email to verify your account.",
                },
            });
        });
    });
});

// Login user
router.post("/login", (req, res) => {
    const { email, password } = req.body;

    const query = `
        SELECT id, username, email, password, profile_picture, is_private, is_verified
        FROM users
        WHERE email = ?
    `;

    db.query(query, [email], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        const user = results[0];

        if (!user.is_verified) {
            return res.status(403).json({
                success: false,
                error: "Please verify your email before logging in.",
                data: null,
            });
        }

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
                    is_private: user.is_private,
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

router.get("/verify", (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).json({
            success: false,
            error: "Invalid verification link.",
            data: null,
        });
    }

    const query = "SELECT * FROM users WHERE verification_token = ?";

    db.query(query, [token], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: "Database error.",
                data: null,
            });
        }

        if (results.length === 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid or expired token.",
                data: null,
            });
        }

        const user = results[0];

        // ⏳ Check token expiry manually
        const now = new Date();
        const expiry = new Date(user.token_expiry);

        if (now > expiry) {
            return res.status(400).json({
                success: false,
                error: "Token has expired. Please register again.",
                data: null,
            });
        }

        const update = "UPDATE users SET is_verified = true WHERE id = ?";
        db.query(update, [results[0].id], (err2) => {
            if (err2) {
                return res.status(500).json({
                    success: false,
                    error: "Failed to verify account.",
                    data: null,
                });
            }

            res.json({
                success: true,
                error: null,
                data: "Account successfully verified! You can now log in.",
            });
        });
    });
});

module.exports = router;

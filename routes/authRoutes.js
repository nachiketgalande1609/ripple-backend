const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const router = express.Router();
const { sendEmail } = require("../utils/mailer");
const crypto = require("crypto");

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

            return res.json({
                success: true,
                error: null,
                data: "Account successfully verified! You can now log in.",
            });
        });
    });
});

router.post("/generate-otp", async (req, res) => {
    const { email } = req.body;

    // Validate email format
    if (!email || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
        return res.status(400).json({
            success: false,
            error: "Invalid email format.",
            data: null,
        });
    }

    // Check if user with that email exists
    const checkUserQuery = `SELECT id FROM users WHERE email = ?`;

    db.query(checkUserQuery, [email], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: "Database error while checking user.",
                data: null,
            });
        }

        if (results.length === 0) {
            return res.status(404).json({
                success: false,
                error: "No user found with this email.",
                data: null,
            });
        }

        // Generate OTP (6 digits)
        const otp = crypto.randomInt(100000, 999999);

        // OTP expires in 10 minutes
        const expiryTime = new Date(Date.now() + 10 * 60 * 1000);

        const updateOtpQuery = `
            UPDATE users
            SET otp = ?, otp_expiry = ?
            WHERE email = ?
        `;

        db.query(updateOtpQuery, [otp, expiryTime, email], async (updateErr) => {
            if (updateErr) {
                return res.status(500).json({
                    success: false,
                    error: "Error saving OTP.",
                    data: null,
                });
            }

            // Send OTP via email
            const otpMessage = `
                <div style="background-color: #f4f4f7; padding: 40px 0; font-family: Arial, sans-serif;">
                    <div style="max-width: 600px; margin: auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); padding: 30px;">
                    <h2 style="text-align: center; color: #333333; margin-bottom: 20px;">Your One-Time Password</h2>
                    <p style="font-size: 16px; color: #555555; text-align: center;">
                        Use the code below to complete your authentication. This code is valid for 10 minutes.
                    </p>
                    <div style="margin: 30px auto; text-align: center;">
                        <span style="display: inline-block; font-size: 28px; font-weight: bold; color: #000000; background-color: #f0f0f0; padding: 12px 24px; border-radius: 6px; letter-spacing: 2px;">
                        ${otp}
                        </span>
                    </div>
                    <p style="font-size: 14px; color: #777777; text-align: center;">
                        If you did not request this code, please ignore this email.
                    </p>
                    </div>
                    <p style="text-align: center; font-size: 12px; color: #aaaaaa; margin-top: 20px;">
                    © 2025 Your Company. All rights reserved.
                    </p>
                </div>
            `;

            const otpSubject = "Your OTP Code for Email Verification";

            await sendEmail(email, otpSubject, "", otpMessage);

            return res.json({
                success: true,
                error: null,
                data: "OTP sent successfully. Please check your email.",
            });
        });
    });
});

// Route to verify OTP entered by user
router.post("/verify-otp", (req, res) => {
    const { email, otp } = req.body;

    // Validate OTP input
    if (!otp || otp.length !== 6) {
        return res.status(400).json({
            success: false,
            error: "Invalid OTP format.",
            data: null,
        });
    }

    // Query the database for the OTP stored
    const query = `
        SELECT otp, otp_expiry
        FROM users
        WHERE email = ?
    `;

    db.query(query, [email], (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({
                success: false,
                error: "User not found or OTP not generated.",
                data: null,
            });
        }

        const user = results[0];

        // Check if OTP has expired
        const now = new Date();
        if (now > new Date(user.otp_expiry)) {
            return res.status(400).json({
                success: false,
                error: "OTP has expired. Please request a new one.",
                data: null,
            });
        }

        // Check if the OTP matches
        if (user.otp !== otp) {
            return res.status(400).json({
                success: false,
                error: "Invalid OTP. Please try again.",
                data: null,
            });
        }

        // OTP is valid, update user record
        const updateQuery = "UPDATE users SET is_verified = true WHERE email = ?";
        db.query(updateQuery, [email], (err2) => {
            if (err2) {
                return res.status(500).json({
                    success: false,
                    error: "Error updating user verification status.",
                    data: null,
                });
            }

            return res.json({
                success: true,
                error: null,
                data: "Email verified successfully.",
            });
        });
    });
});

router.post("/reset-password", async (req, res) => {
    const { email, otp, password } = req.body;

    if (!email || !otp || !password) {
        return res.status(400).json({
            success: false,
            error: "Missing required fields.",
            data: null,
        });
    }

    const query = `SELECT otp, otp_expiry FROM users WHERE email = ?`;

    db.query(query, [email], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({
                success: false,
                error: "User not found or OTP not generated.",
                data: null,
            });
        }

        const user = results[0];

        // Check if OTP expired
        const now = new Date();
        if (now > new Date(user.otp_expiry)) {
            return res.status(400).json({
                success: false,
                error: "OTP has expired. Please request a new one.",
                data: null,
            });
        }

        // Validate OTP match
        if (user.otp !== otp) {
            return res.status(400).json({
                success: false,
                error: "Invalid OTP. Please try again.",
                data: null,
            });
        }

        // Hash the new password
        try {
            const hashedPassword = await bcrypt.hash(password, 10);

            const updateQuery = `
                UPDATE users 
                SET password = ?, otp = NULL, otp_expiry = NULL 
                WHERE email = ?
            `;

            db.query(updateQuery, [hashedPassword, email], (err2) => {
                if (err2) {
                    return res.status(500).json({
                        success: false,
                        error: "Failed to reset password.",
                        data: null,
                    });
                }

                return res.json({
                    success: true,
                    error: null,
                    data: "Password reset successful.",
                });
            });
        } catch (hashError) {
            console.error("Hashing error:", hashError);
            return res.status(500).json({
                success: false,
                error: "Internal error while resetting password.",
                data: null,
            });
        }
    });
});

module.exports = router;

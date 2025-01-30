const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const router = express.Router();

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

router.get("/profile/:userId", (req, res) => {
    const { userId } = req.params;

    const query = "SELECT id, username, email, bio, profile_picture FROM users WHERE id = ?";
    db.query(query, [userId], (err, results) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message,
                data: null,
            });
        }

        // If no user found, return a 404 error
        if (results.length === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found",
                data: null,
            });
        }

        // If user found, return the user data
        const user = results[0];
        res.status(200).json({
            success: true,
            error: null,
            data: {
                id: user.id,
                username: user.username,
                email: user.email,
                bio: user.bio,
                profile_picture: user.profile_picture,
            },
        });
    });
});

module.exports = router;

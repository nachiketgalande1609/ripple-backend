const express = require("express");
const db = require("../db");
const router = express.Router();

router.get("/", (req, res) => {
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

module.exports = router;

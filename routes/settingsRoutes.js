const express = require("express");
const db = require("../db");
const router = express.Router();

router.patch("/update-account-privacy", (req, res) => {
    const userId = req.headers["x-current-user-id"];
    const { isPrivate } = req.body;

    query = "UPDATE users SET is_private=? WHERE id=?";

    db.query(query, [isPrivate, userId], (updateErr) => {
        if (updateErr) {
            return res.status(500).json({
                success: false,
                error: updateErr.message,
                data: null,
            });
        }

        res.status(200).json({
            success: true,
            error: null,
            data: { message: "privacy updated successfully" },
        });
    });
});

module.exports = router;

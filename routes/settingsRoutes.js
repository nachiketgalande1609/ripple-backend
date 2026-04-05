const express = require("express");
const { promisePool: db } = require("../db");
const router = express.Router();

router.patch("/update-account-privacy", async (req, res) => {
  try {
    const currentUserId = req.headers["x-current-user-id"];
    const { isPrivate } = req.body;

    const query = "UPDATE users SET is_private=? WHERE id=?";

    await db.query(query, [isPrivate, currentUserId]);

    return res.status(200).json({
      success: true,
      error: null,
      data: { message: "privacy updated successfully" },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      data: null,
    });
  }
});

module.exports = router;

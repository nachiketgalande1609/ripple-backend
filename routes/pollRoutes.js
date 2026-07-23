const express = require("express");
const { promisePool: db } = require("../db");
const router = express.Router();

// ── Auto-create tables ────────────────────────────────────────────────────────
const initTables = async () => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS polls (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            question VARCHAR(500) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS poll_options (
            id INT AUTO_INCREMENT PRIMARY KEY,
            poll_id INT NOT NULL,
            option_text VARCHAR(255) NOT NULL
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS poll_votes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            poll_id INT NOT NULL,
            option_id INT NOT NULL,
            user_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_vote (poll_id, user_id)
        )
    `);
};

initTables().catch((err) => console.error("Poll table init error:", err));

// ── POST /create ──────────────────────────────────────────────────────────────
router.post("/create", async (req, res) => {
    const { question, options, userId } = req.body;

    if (!question || !Array.isArray(options) || options.length < 2 || !userId) {
        return res.status(400).json({ success: false, error: "question, at least 2 options and userId are required." });
    }

    const filteredOptions = options.filter((o) => o && o.trim());
    if (filteredOptions.length < 2) {
        return res.status(400).json({ success: false, error: "At least 2 non-empty options required." });
    }

    try {
        const [pollResult] = await db.query(
            "INSERT INTO polls (user_id, question) VALUES (?, ?)",
            [userId, question.trim()]
        );
        const pollId = pollResult.insertId;

        for (const opt of filteredOptions) {
            await db.query("INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)", [pollId, opt.trim()]);
        }

        return res.status(201).json({ success: true, data: { pollId } });
    } catch (err) {
        console.error("Create poll error:", err);
        return res.status(500).json({ success: false, error: "Internal server error." });
    }
});

// ── POST /vote ────────────────────────────────────────────────────────────────
router.post("/vote", async (req, res) => {
    const { pollId, optionId, userId } = req.body;

    if (!pollId || !optionId || !userId) {
        return res.status(400).json({ success: false, error: "pollId, optionId and userId are required." });
    }

    try {
        // Check if user already voted
        const [existing] = await db.query(
            "SELECT id FROM poll_votes WHERE poll_id = ? AND user_id = ?",
            [pollId, userId]
        );
        if (existing.length > 0) {
            return res.status(409).json({ success: false, error: "User has already voted on this poll." });
        }

        await db.query(
            "INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)",
            [pollId, optionId, userId]
        );

        return res.json({ success: true });
    } catch (err) {
        console.error("Vote poll error:", err);
        return res.status(500).json({ success: false, error: "Internal server error." });
    }
});

// ── Helper: build poll response ───────────────────────────────────────────────
const buildPollResponse = async (poll, currentUserId) => {
    const [options] = await db.query(
        `SELECT po.id, po.option_text, COUNT(pv.id) AS vote_count
         FROM poll_options po
         LEFT JOIN poll_votes pv ON pv.option_id = po.id
         WHERE po.poll_id = ?
         GROUP BY po.id, po.option_text`,
        [poll.id]
    );

    const [voteRows] = await db.query(
        "SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?",
        [poll.id, currentUserId || 0]
    );
    const user_voted_option = voteRows.length > 0 ? voteRows[0].option_id : null;

    const total_votes = options.reduce((sum, o) => sum + Number(o.vote_count), 0);

    return {
        id: poll.id,
        user_id: poll.user_id,
        question: poll.question,
        username: poll.username || null,
        profile_picture: poll.profile_picture || null,
        created_at: poll.created_at,
        options: options.map((o) => ({
            id: o.id,
            option_text: o.option_text,
            vote_count: Number(o.vote_count),
        })),
        user_voted_option,
        total_votes,
    };
};

// ── GET /fetch/:pollId ────────────────────────────────────────────────────────
router.get("/fetch/:pollId", async (req, res) => {
    const { pollId } = req.params;
    const currentUserId = req.headers["x-current-user-id"];

    try {
        const [polls] = await db.query(
            `SELECT p.*, u.username, u.profile_picture
             FROM polls p
             JOIN users u ON u.id = p.user_id
             WHERE p.id = ?`,
            [pollId]
        );
        if (polls.length === 0) {
            return res.status(404).json({ success: false, error: "Poll not found." });
        }

        const data = await buildPollResponse(polls[0], currentUserId);
        return res.json({ success: true, data });
    } catch (err) {
        console.error("Fetch poll error:", err);
        return res.status(500).json({ success: false, error: "Internal server error." });
    }
});

// ── GET /feed ─────────────────────────────────────────────────────────────────
router.get("/feed", async (req, res) => {
    const currentUserId = req.headers["x-current-user-id"];

    try {
        const [polls] = await db.query(
            `SELECT p.*, u.username, u.profile_picture
             FROM polls p
             JOIN users u ON u.id = p.user_id
             ORDER BY p.created_at DESC`
        );

        const data = await Promise.all(polls.map((poll) => buildPollResponse(poll, currentUserId)));
        return res.json({ success: true, data });
    } catch (err) {
        console.error("Poll feed error:", err);
        return res.status(500).json({ success: false, error: "Internal server error." });
    }
});

// ── DELETE /delete/:pollId ────────────────────────────────────────────────────
router.delete("/delete/:pollId", async (req, res) => {
    const { pollId } = req.params;
    const userId = req.headers["x-current-user-id"];

    try {
        const [polls] = await db.query("SELECT user_id FROM polls WHERE id = ?", [pollId]);
        if (polls.length === 0) return res.status(404).json({ success: false, error: "Poll not found." });
        if (String(polls[0].user_id) !== String(userId)) {
            return res.status(403).json({ success: false, error: "Not authorized." });
        }

        await db.query("DELETE FROM poll_votes WHERE poll_id = ?", [pollId]);
        await db.query("DELETE FROM poll_options WHERE poll_id = ?", [pollId]);
        await db.query("DELETE FROM polls WHERE id = ?", [pollId]);

        return res.json({ success: true });
    } catch (err) {
        console.error("Delete poll error:", err);
        return res.status(500).json({ success: false, error: "Internal server error." });
    }
});

module.exports = router;

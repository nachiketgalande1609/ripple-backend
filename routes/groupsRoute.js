const express = require("express");
const router = express.Router();
const { promisePool: db } = require("../db");

// POST /api/groups/create
router.post("/create", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { name, description, memberIds } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: "Group name is required", data: null });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO \`groups\` (name, description, created_by, created_at)
       VALUES (?, ?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'))`,
      [name.trim(), description?.trim() || null, currentUserId]
    );
    const groupId = result.insertId;

    // Add creator as admin
    const allMembers = [parseInt(currentUserId), ...(memberIds || []).filter((id) => id !== parseInt(currentUserId))];
    for (const uid of allMembers) {
      await db.query(
        `INSERT IGNORE INTO group_members (group_id, user_id, role)
         VALUES (?, ?, ?)`,
        [groupId, uid, uid === parseInt(currentUserId) ? "admin" : "member"]
      );
    }

    const [[group]] = await db.query(
      `SELECT g.id, g.name, g.description, g.profile_picture, g.created_at,
              COUNT(gm.user_id) AS member_count
       FROM \`groups\` g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       WHERE g.id = ?
       GROUP BY g.id`,
      [groupId]
    );

    return res.json({ success: true, data: group, error: null });
  } catch (err) {
    console.error("Error creating group:", err);
    return res.status(500).json({ success: false, error: err.message, data: null });
  }
});

// GET /api/groups/list
router.get("/list", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];

  try {
    const [groups] = await db.query(
      `SELECT
         g.id,
         g.name,
         g.description,
         g.profile_picture,
         g.created_at,
         COUNT(DISTINCT gm2.user_id) AS member_count,
         (
           SELECT gm3.message_text FROM group_messages gm3
           WHERE gm3.group_id = g.id
           ORDER BY gm3.timestamp DESC, gm3.id DESC LIMIT 1
         ) AS latest_message,
         (
           SELECT u2.username FROM group_messages gm4
           JOIN users u2 ON u2.id = gm4.sender_id
           WHERE gm4.group_id = g.id
           ORDER BY gm4.timestamp DESC, gm4.id DESC LIMIT 1
         ) AS latest_message_sender,
         (
           SELECT gm5.timestamp FROM group_messages gm5
           WHERE gm5.group_id = g.id
           ORDER BY gm5.timestamp DESC, gm5.id DESC LIMIT 1
         ) AS latest_message_timestamp
       FROM \`groups\` g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
       LEFT JOIN group_members gm2 ON gm2.group_id = g.id
       GROUP BY g.id`,
      [currentUserId]
    );

    return res.json({ success: true, data: groups, error: null });
  } catch (err) {
    console.error("Error listing groups:", err);
    return res.status(500).json({ success: false, error: err.message, data: null });
  }
});

// GET /api/groups/messages?groupId=&limit=&offset=
router.get("/messages", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { groupId, limit = 30, offset = 0 } = req.query;

  if (!groupId) {
    return res.status(400).json({ success: false, error: "groupId required", data: null });
  }

  // Verify membership
  const [[membership]] = await db.query(
    `SELECT id FROM group_members WHERE group_id = ? AND user_id = ?`,
    [groupId, currentUserId]
  );
  if (!membership) {
    return res.status(403).json({ success: false, error: "Not a member", data: null });
  }

  try {
    const [messages] = await db.query(
      `SELECT
         gm.id AS message_id,
         gm.group_id,
         gm.sender_id,
         u.username AS sender_username,
         u.profile_picture AS sender_profile_picture,
         gm.message_text,
         gm.file_url,
         gm.file_name,
         gm.file_size,
         gm.timestamp,
         gm.reply_to,
         gm.media_width,
         gm.media_height,
         gm.reactions,
         gm.post_id
       FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = ?
       ORDER BY gm.timestamp DESC, gm.id DESC
       LIMIT ? OFFSET ?`,
      [groupId, parseInt(limit), parseInt(offset)]
    );

    const mapped = messages.map((m) => ({
      ...m,
      saved: true,
      reactions: m.reactions
        ? (typeof m.reactions === "string" ? JSON.parse(m.reactions) : m.reactions)
        : [],
    }));

    return res.json({ success: true, data: mapped, error: null });
  } catch (err) {
    console.error("Error fetching group messages:", err);
    return res.status(500).json({ success: false, error: err.message, data: null });
  }
});

// GET /api/groups/members/:groupId
router.get("/members/:groupId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { groupId } = req.params;

  const [[membership]] = await db.query(
    `SELECT id FROM group_members WHERE group_id = ? AND user_id = ?`,
    [groupId, currentUserId]
  );
  if (!membership) {
    return res.status(403).json({ success: false, error: "Not a member", data: null });
  }

  try {
    const [members] = await db.query(
      `SELECT u.id, u.username, u.profile_picture, gm.role, gm.joined_at
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?
       ORDER BY gm.role = 'admin' DESC, u.username ASC`,
      [groupId]
    );
    return res.json({ success: true, data: members, error: null });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, data: null });
  }
});

// DELETE /api/groups/leave/:groupId
router.delete("/leave/:groupId", async (req, res) => {
  const currentUserId = req.headers["x-current-user-id"];
  const { groupId } = req.params;

  try {
    await db.query(
      `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`,
      [groupId, currentUserId]
    );
    return res.json({ success: true, data: "Left group", error: null });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, data: null });
  }
});

module.exports = router;

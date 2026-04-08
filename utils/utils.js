const { promisePool: db } = require("../db");
const { getIo, getUserSockets } = require("../socket");

const getTimeAgo = (createdAt) => {
  const now = new Date();
  const createdDate = new Date(createdAt);

  const diffInSeconds = Math.floor((now - createdDate) / 1000);

  if (diffInSeconds < 60) return `${diffInSeconds} sec ago`;

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes} min ago`;

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours} hr ago`;

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays} days ago`;

  const diffInWeeks = Math.floor(diffInDays / 7);
  if (diffInWeeks < 4) return `${diffInWeeks} weeks ago`;

  let years = now.getFullYear() - createdDate.getFullYear();
  let months = now.getMonth() - createdDate.getMonth();

  // ✅ adjust based on day
  if (now.getDate() < createdDate.getDate()) {
    months--;
  }

  // normalize negative months
  if (months < 0) {
    years--;
    months += 12;
  }

  if (years === 0) {
    return `${months} months ago`;
  }

  return `${years} years ago`;
};

async function createNotification(
  userId,
  senderId,
  type,
  message,
  postId = null,
  commentId = null,
) {
  const insertNotificationQuery = `
        INSERT INTO notifications (user_id, sender_id, type, message, post_id, comment_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'));
    `;

  const [result] = await db.query(insertNotificationQuery, [
    userId,
    senderId,
    type,
    message,
    postId,
    commentId,
  ]);
  return result;
}

const emitUnreadNotificationCount = async (targetUserId) => {
  const query = `
    SELECT COUNT(*) AS unread_count
    FROM notifications
    WHERE user_id = ? AND is_read = FALSE;
  `;

  try {
    const [results] = await db.query(query, [targetUserId]);

    const unreadCount = results[0]?.unread_count || 0;

    const io = getIo();
    const userSockets = getUserSockets();
    const receiverSocketId = userSockets[targetUserId];

    if (receiverSocketId) {
      io.to(receiverSocketId).emit("unreadCountResponse", {
        targetUserId,
        unreadCount,
      });
    }
  } catch (err) {
    console.error("Error fetching unread count:", err.message);
  }
};

const emitNotifications = (targetUserId, notificationMessage) => {
  const io = getIo();
  const userSockets = getUserSockets();
  const receiverSocketId = userSockets[targetUserId];

  if (receiverSocketId) {
    io.to(receiverSocketId).emit("notificationAlert", {
      targetUserId,
      notificationMessage,
    });
  }
};

module.exports = {
  getTimeAgo,
  createNotification,
  emitUnreadNotificationCount,
  emitNotifications,
};

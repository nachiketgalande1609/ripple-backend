const db = require("../db");

const getTimeAgo = (createdAt) => {
    const now = new Date();
    const diffInSeconds = Math.floor((now - createdAt) / 1000);

    if (diffInSeconds < 60) return `${diffInSeconds} sec ago`;
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) return `${diffInMinutes} min ago`;
    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) return `${diffInHours} hr ago`;
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) return `${diffInDays} days ago`;
    const diffInWeeks = Math.floor(diffInDays / 7);
    if (diffInWeeks < 4) return `${diffInWeeks} weeks ago`;
    const diffInMonths = Math.floor(diffInDays / 30);
    if (diffInMonths < 12) return `${diffInMonths} months ago`;
    const diffInYears = Math.floor(diffInDays / 365);
    return `${diffInYears} years ago`;
};

function createNotification(userId, senderId, type, message, postId = null, commentId = null) {
    return new Promise((resolve, reject) => {
        const insertNotificationQuery = `
            INSERT INTO notifications (user_id, sender_id, type, message, post_id, comment_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW());
        `;

        db.query(insertNotificationQuery, [userId, senderId, type, message, postId, commentId], (err, result) => {
            if (err) {
                return reject(err);
            }
            resolve(result);
        });
    });
}

module.exports = { getTimeAgo, createNotification };

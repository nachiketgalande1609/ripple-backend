const { Server } = require("socket.io");

let io;
let userSockets = {};

function initializeSocket(server, db) {
    io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
        pingInterval: 25000,
        pingTimeout: 60000,
    });

    io.on("connection", (socket) => {
        socket.on("registerUser", async (userId) => {
            if (userSockets[userId] !== socket.id) {
                userSockets[userId] = socket.id;

                const onlineUsers = Object.keys(userSockets);
                io.emit("onlineUsers", onlineUsers);

                try {
                    await db.query(
                        `UPDATE messages SET delivered = TRUE, delivered_timestamp = CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata') WHERE receiver_id = ? AND delivered = FALSE`,
                        [userId],
                    );

                    const [unreadMessages] = await db.query(`SELECT * FROM messages WHERE receiver_id = ? AND delivered = TRUE AND is_read = FALSE`, [
                        userId,
                    ]);

                    unreadMessages.forEach((message) => {
                        const senderSocketId = userSockets[message.sender_id];
                        if (senderSocketId) {
                            io.to(senderSocketId).emit("messageDelivered", {
                                messageId: message.message_id,
                                timestamp: new Date().toISOString(),
                            });
                        }
                    });
                } catch (err) {
                    console.error("Error in registerUser:", err.message);
                }
            }
        });

        socket.on("sendMessage", async (data) => {
            const { senderId, receiverId, text, tempId, fileUrl, fileName, fileSize, replyTo, mediaWidth, mediaHeight, postId } = data;

            const receiverSocketId = userSockets[receiverId];
            const senderSocketId = userSockets[senderId];
            const delivered = !!receiverSocketId;
            const deliveredTimestamp = delivered ? new Date() : null;

            try {
                const [results] = await db.query(
                    `INSERT INTO messages (sender_id, receiver_id, message_text, file_url, file_name, file_size, timestamp, delivered, delivered_timestamp, reply_to, media_width, media_height, post_id) 
                     VALUES (?, ?, ?, ?, ?, ?, CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata'), ?, ?, ?, ?, ?, ?);`,
                    [
                        senderId,
                        receiverId,
                        text,
                        fileUrl,
                        fileName,
                        fileSize,
                        delivered,
                        deliveredTimestamp,
                        replyTo,
                        mediaWidth,
                        mediaHeight,
                        postId,
                    ],
                );

                const messageId = results.insertId;
                io.to(senderSocketId).emit("messageSaved", { tempId, messageId, timestamp: new Date().toISOString() });

                if (receiverSocketId) {
                    const [[{ unreadCount }]] = await db.query(
                        `SELECT COUNT(*) AS unreadCount FROM messages WHERE receiver_id = ? AND is_read = FALSE`,
                        [receiverId],
                    );

                    io.to(receiverSocketId).emit("unreadMessagesCount", { unreadCount });
                    io.to(receiverSocketId).emit("receiveMessage", {
                        messageId,
                        senderId,
                        message_text: text,
                        timestamp: new Date().toISOString(),
                        fileUrl,
                        fileName,
                        fileSize,
                        replyTo,
                        mediaWidth,
                        mediaHeight,
                    });
                    io.to(senderSocketId).emit("messageDelivered", {
                        messageId,
                        deliveredTimestamp: deliveredTimestamp?.toISOString() ?? null,
                        timestamp: new Date().toISOString(),
                    });
                }
            } catch (err) {
                console.error("Error in sendMessage:", err.message);
            }
        });

        socket.on("messageRead", async (data) => {
            const { messageIds, senderId, receiverId } = data;

            if (!messageIds || messageIds.length === 0) {
                console.error("No message IDs provided.");
                return;
            }

            const senderSocketId = userSockets[senderId];

            try {
                await db.query(
                    `UPDATE messages SET is_read = TRUE, read_timestamp = CONVERT_TZ(NOW(), 'UTC', 'Asia/Kolkata') WHERE message_id IN (?)`,
                    [messageIds],
                );

                const [results] = await db.query(`SELECT message_id, read_timestamp FROM messages WHERE message_id IN (?)`, [messageIds]);

                if (senderSocketId) {
                    io.to(senderSocketId).emit("messageRead", {
                        receiverId,
                        messageIds: results.map((msg) => ({
                            messageId: msg.message_id,
                            readTimestamp: msg.read_timestamp.toISOString(),
                        })),
                    });
                }
            } catch (err) {
                console.error("Error in messageRead:", err.message);
            }
        });

        socket.on("typing", (data) => {
            const { senderId, receiverId } = data;
            const receiverSocketId = userSockets[receiverId];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("typing", { senderId, receiverId });
            }
        });

        socket.on("stopTyping", (data) => {
            const { senderId, receiverId } = data;
            const receiverSocketId = userSockets[receiverId];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("stopTyping", { senderId, receiverId });
            }
        });

        socket.on("send-reaction", async (data) => {
            const { messageId, senderUserId, reaction } = data;

            if (!messageId || !senderUserId) {
                console.error("Invalid reaction data.");
                return;
            }

            try {
                if (reaction === null || reaction === "") {
                    await db.query(`UPDATE messages SET reactions = JSON_REMOVE(reactions, CONCAT('$."', ?, '"')) WHERE message_id = ?`, [
                        senderUserId,
                        messageId,
                    ]);
                } else {
                    await db.query(
                        `UPDATE messages SET reactions = JSON_SET(COALESCE(reactions, '{}'), CONCAT('$."', ?, '"'), ?) WHERE message_id = ?`,
                        [senderUserId, reaction, messageId],
                    );
                }

                const [[user]] = await db.query(`SELECT username, profile_picture FROM users WHERE id = ?`, [senderUserId]);

                if (!user) {
                    console.error("User not found for reaction.");
                    return;
                }

                const [[message]] = await db.query(`SELECT receiver_id, sender_id FROM messages WHERE message_id = ?`, [messageId]);

                if (message) {
                    const { receiver_id, sender_id } = message;
                    const targetUserId = senderUserId === sender_id ? receiver_id : sender_id;
                    const receiverSocketId = userSockets[targetUserId];

                    if (receiverSocketId) {
                        io.to(receiverSocketId).emit("reaction-received", {
                            messageId,
                            reaction: {
                                user_id: senderUserId.toString(),
                                reaction,
                                username: user.username,
                                profile_picture: user.profile_picture,
                            },
                        });
                    }
                }
            } catch (err) {
                console.error("Error in send-reaction:", err.message);
            }
        });

        socket.on("viewStory", async (data) => {
            const { user_id, story_id } = data;

            if (!user_id || !story_id) return;

            try {
                const [[storyOwner]] = await db.query(`SELECT user_id FROM stories WHERE id = ?`, [story_id]);

                if (!storyOwner) return;

                if (storyOwner.user_id === user_id) {
                    return;
                }

                const [existing] = await db.query(`SELECT * FROM story_views WHERE user_id = ? AND story_id = ?`, [user_id, story_id]);

                if (existing.length > 0) {
                    return;
                }

                await db.query(`INSERT INTO story_views (user_id, story_id) VALUES (?, ?)`, [user_id, story_id]);

                socket.emit("storyViewSuccess", { message: "Story view recorded successfully!" });
                socket.broadcast.emit("newStoryView", { user_id, story_id });
            } catch (err) {
                console.error("Error tracking story view:", err.message);
            }
        });

        socket.on("callUser", (data) => {
            const { from, to, signal, callerUsername, callerProfilePicture } = data;

            const receiverSocketId = userSockets[to];

            if (receiverSocketId) {
                io.to(receiverSocketId).emit("callReceived", { signal, from, callerUsername, callerProfilePicture });
            } else {
                console.warn("Receiver not found in userSockets for userId:", to);
            }
        });

        socket.on("answerCall", (data) => {
            const { to, signal } = data;
            const receiverSocketId = userSockets[to];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("callAnswered", { signal });
            }
        });

        socket.on("iceCandidate", (data) => {
            const { to, candidate } = data;
            const receiverSocketId = userSockets[to];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("iceCandidateReceived", { candidate });
            }
        });

        socket.on("endCall", (data) => {
            const { to } = data;
            const receiverSocketId = userSockets[to];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("endCall");
            }
        });

        socket.on("disconnect", () => {
            for (let userId in userSockets) {
                if (userSockets[userId] === socket.id) {
                    delete userSockets[userId];
                    const onlineUsers = Object.keys(userSockets);
                    io.emit("onlineUsers", onlineUsers); // broadcast to everyone, not just disconnected socket
                    break;
                }
            }
        });
    });
}

function getIo() {
    if (!io) throw new Error("Socket.io has not been initialized!");
    return io;
}

function getUserSockets() {
    return userSockets;
}

module.exports = { initializeSocket, getIo, getUserSockets };

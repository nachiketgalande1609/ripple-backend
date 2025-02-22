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
        socket.on("registerUser", (userId) => {
            if (userSockets[userId] !== socket.id) {
                userSockets[userId] = socket.id;

                const onlineUsers = Object.keys(userSockets);
                io.emit("onlineUsers", onlineUsers);

                db.query(
                    `UPDATE messages SET delivered = TRUE, delivered_timestamp = NOW() WHERE receiver_id = ? AND delivered = FALSE`,
                    [userId],
                    (err) => {
                        if (err) {
                            console.error("Error marking messages as delivered:", err.message);
                        } else {
                            db.query(
                                `SELECT * FROM messages WHERE receiver_id = ? AND delivered = TRUE AND is_read = FALSE`,
                                [userId],
                                (err, results) => {
                                    if (err) {
                                        console.error("Error retrieving unread messages:", err.message);
                                        return;
                                    }

                                    results.forEach((message) => {
                                        const senderSocketId = userSockets[message.sender_id];
                                        if (senderSocketId) {
                                            io.to(senderSocketId).emit("messageDelivered", {
                                                messageId: message.message_id,
                                                timestamp: new Date().toISOString(),
                                            });
                                        }
                                    });
                                }
                            );
                        }
                    }
                );
            }
        });

        // Handle sending messages
        socket.on("sendMessage", (data) => {
            const { senderId, receiverId, text, tempId, fileUrl, fileName, fileSize, replyTo, mediaWidth, mediaHeight } = data;

            const receiverSocketId = userSockets[receiverId];
            const senderSocketId = userSockets[senderId];

            const delivered = !!receiverSocketId;
            const deliveredTimestamp = delivered ? new Date() : null;

            db.query(
                `
                    INSERT INTO messages (sender_id, receiver_id, message_text, file_url, file_name, file_size, timestamp, delivered, delivered_timestamp, reply_to, media_width, media_height) 
                    VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?);
                `,
                [senderId, receiverId, text, fileUrl, fileName, fileSize, delivered, deliveredTimestamp, replyTo, mediaWidth, mediaHeight],
                (err, results) => {
                    if (err) {
                        console.error("Error saving message:", err.message);
                        return;
                    }

                    const messageId = results.insertId;

                    io.to(senderSocketId).emit("messageSaved", { tempId, messageId, timestamp: new Date().toISOString() });

                    if (receiverSocketId) {
                        db.query(
                            `SELECT COUNT(*) AS unreadCount FROM messages WHERE receiver_id = ? AND is_read = FALSE`,
                            [receiverId],
                            (err, results) => {
                                if (err) {
                                    console.error("Error counting unread messages:", err.message);
                                    return;
                                }

                                const unreadCount = results[0]?.unreadCount || 0;

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
                                    deliveredTimestamp: deliveredTimestamp ? deliveredTimestamp.toISOString() : null,
                                    timestamp: new Date().toISOString(),
                                });
                            }
                        );
                    }
                }
            );
        });

        socket.on("messageRead", (data) => {
            const { messageIds, senderId, receiverId } = data;

            if (!messageIds || messageIds.length === 0) {
                console.error("No message IDs provided.");
                return;
            }

            const senderSocketId = userSockets[senderId];

            db.query(`UPDATE messages SET is_read = TRUE, read_timestamp = NOW() WHERE message_id IN (?)`, [messageIds], (err) => {
                if (err) {
                    console.error("Error updating message status:", err.message);
                    return;
                }

                // Fetch updated read timestamps from the database
                db.query(`SELECT message_id, read_timestamp FROM messages WHERE message_id IN (?)`, [messageIds], (err, results) => {
                    if (err) {
                        console.error("Error fetching read timestamps:", err.message);
                        return;
                    }

                    if (senderSocketId) {
                        io.to(senderSocketId).emit("messageRead", {
                            receiverId,
                            messageIds: results.map((msg) => ({
                                messageId: msg.message_id,
                                readTimestamp: msg.read_timestamp.toISOString(),
                            })),
                        });
                    }
                });
            });
        });

        // Handle typing event (show typing indicator)
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

        socket.on("send-reaction", (data) => {
            const { messageId, senderUserId, reaction } = data;

            if (!messageId || !senderUserId) {
                console.error("Invalid reaction data.");
                return;
            }

            let query;
            let queryParams;

            if (reaction === null) {
                // Remove the reaction if reaction is null
                query = `UPDATE messages 
                 SET reactions = JSON_REMOVE(reactions, CONCAT('$."', ? , '"')) 
                 WHERE message_id = ?`;
                queryParams = [senderUserId, messageId];
            } else {
                // Add or update reaction
                query = `UPDATE messages 
                 SET reactions = JSON_SET(COALESCE(reactions, '{}'), CONCAT('$."', ? , '"'), ?) 
                 WHERE message_id = ?`;
                queryParams = [senderUserId, reaction, messageId];
            }

            db.query(query, queryParams, (err) => {
                if (err) {
                    console.error("Error updating reactions:", err.message);
                    return;
                }

                // Fetch updated message to determine receiver
                db.query(`SELECT receiver_id, sender_id FROM messages WHERE message_id = ?`, [messageId], (err, results) => {
                    if (err) {
                        console.error("Error fetching message data:", err.message);
                        return;
                    }

                    if (results.length > 0) {
                        const { receiver_id, sender_id } = results[0];
                        const targetUserId = senderUserId === sender_id ? receiver_id : sender_id;
                        const receiverSocketId = userSockets[targetUserId];

                        if (receiverSocketId) {
                            io.to(receiverSocketId).emit("reaction-received", {
                                messageId,
                                senderUserId,
                                reaction,
                            });
                        }
                    }
                });
            });
        });

        socket.on("viewStory", async (data) => {
            const { user_id, story_id } = data;

            if (!user_id || !story_id) return;

            try {
                // Check if the user is viewing their own story
                const checkStoryOwnerQuery = `
            SELECT user_id FROM stories 
            WHERE id = ?
        `;
                db.query(checkStoryOwnerQuery, [story_id], (err, result) => {
                    if (err) {
                        console.error("Error checking story owner:", err);
                        return;
                    }

                    // If the user is the owner of the story, don't register the view
                    if (result.length > 0 && result[0].user_id === user_id) {
                        console.log(`User ${user_id} is viewing their own story ${story_id}. No view will be registered.`);
                        return;
                    }

                    // Check if the user has already viewed the story
                    const checkQuery = `
                SELECT * FROM story_views 
                WHERE user_id = ? AND story_id = ?
            `;
                    db.query(checkQuery, [user_id, story_id], (err, result) => {
                        if (err) {
                            console.error("Error checking for existing view:", err);
                            return;
                        }

                        if (result.length > 0) {
                            console.log(`User ${user_id} has already viewed story ${story_id}`);
                            return;
                        }

                        // Register the view if not already registered
                        const query = `
                    INSERT INTO story_views (user_id, story_id)
                    VALUES (?, ?)
                `;
                        db.query(query, [user_id, story_id], (err, result) => {
                            if (err) {
                                console.error("Error inserting view:", err);
                                return;
                            }

                            socket.emit("storyViewSuccess", { message: "Story view recorded successfully!" });

                            socket.broadcast.emit("newStoryView", { user_id, story_id });
                        });
                    });
                });
            } catch (error) {
                console.error("Error tracking story view:", error);
            }
        });

        // In your backend socket code
        socket.on("callUser", (data) => {
            const { from, to, signal, callerUsername, callerProfilePicture } = data; // Add callerProfilePicture
            const receiverSocketId = userSockets[to];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("callReceived", { signal, from, callerUsername, callerProfilePicture }); // Pass callerProfilePicture
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

        // Add this to your backend socket code
        socket.on("endCall", (data) => {
            const { to } = data;
            const receiverSocketId = userSockets[to];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit("endCall");
            }
        });

        // Handle disconnect event and clean up the mapping
        socket.on("disconnect", (reason) => {
            // console.log(`User ${socket.id} disconnected due to ${reason}`);
            for (let userId in userSockets) {
                if (userSockets[userId] === socket.id) {
                    const onlineUsers = Object.keys(userSockets);
                    socket.emit("onlineUsers", onlineUsers);

                    delete userSockets[userId];
                    // console.log(`User ${userId} removed from userSockets`);
                    break;
                }
            }
        });
    });
}

// Function to get io instance after initialization
function getIo() {
    if (!io) {
        throw new Error("Socket.io has not been initialized!");
    }
    return io;
}

// Function to get the latest userSockets reference
function getUserSockets() {
    return userSockets;
}

module.exports = { initializeSocket, getIo, getUserSockets };

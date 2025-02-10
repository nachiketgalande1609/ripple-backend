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
            const { senderId, receiverId, text, tempId, fileUrl, fileName, fileSize } = data;

            const receiverSocketId = userSockets[receiverId];
            const senderSocketId = userSockets[senderId];

            const delivered = !!receiverSocketId;
            const deliveredTimestamp = delivered ? new Date() : null;

            db.query(
                `
                    INSERT INTO messages (sender_id, receiver_id, message_text, file_url, file_name, file_size, timestamp, delivered, delivered_timestamp) 
                    VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?);
                `,
                [senderId, receiverId, text, fileUrl, fileName, fileSize, delivered, deliveredTimestamp],
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

const { Server } = require("socket.io");

let io;
let userSockets = {}; // Store user ID -> socket ID mapping

function initializeSocket(server, db) {
    io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
        pingInterval: 25000, // Default is 25000 (25 seconds)
        pingTimeout: 60000, // Default is 60000 (60 seconds)
    });

    io.on("connection", (socket) => {
        console.log(`User connected: ${socket.id}`);

        // Store user socket mapping when a user connects
        socket.on("registerUser", (userId) => {
            if (userSockets[userId] !== socket.id) {
                userSockets[userId] = socket.id;
                console.log(`User ${userId} registered with socket ID: ${socket.id}`);
            }
        });

        // Handle sending messages
        socket.on("sendMessage", (data) => {
            const { senderId, receiverId, text } = data;
            const receiverSocketId = userSockets[receiverId];

            db.query(
                `
                INSERT INTO messages (sender_id, receiver_id, message_text, timestamp)
                VALUES (?, ?, ?, NOW());
                `,
                [senderId, receiverId, text],
                (err, results) => {
                    if (err) {
                        console.error("Error saving message:", err.message);
                        return;
                    }
                    console.log("Message saved to database");

                    if (receiverSocketId) {
                        io.to(receiverSocketId).emit("receiveMessage", { senderId, message_text: text });
                        console.log(`Message sent to user ${receiverId}`);
                    } else {
                        console.log(`User ${receiverId} is not online.`);
                    }
                }
            );
        });

        // Handle disconnect event and clean up the mapping
        socket.on("disconnect", (reason) => {
            console.log(`User ${socket.id} disconnected due to ${reason}`);
            for (let userId in userSockets) {
                if (userSockets[userId] === socket.id) {
                    delete userSockets[userId];
                    console.log(`User ${userId} removed from userSockets`);
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

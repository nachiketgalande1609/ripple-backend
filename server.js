const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const mysql = require("mysql2");
const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const postRoutes = require("./routes/postRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const followRoutes = require("./routes/followRoutes");
const searchRoutes = require("./routes/searchRoute");
const settingsRoutes = require("./routes/settingsRoutes");
const messagesRoutes = require("./routes/messagesRoute");

dotenv.config();

const app = express();
const http = require("http");
const { Server } = require("socket.io");

const port = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.json());

const corsOptions = {
    origin: "*",
    credentials: true,
};
app.use(cors(corsOptions));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/follow", followRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/messages", messagesRoutes);

// MySQL connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

db.connect((err) => {
    if (err) {
        console.error("Error connecting to the database: " + err.stack);
        return;
    }
    console.log("Connected to the database.");
});

// Create an HTTP server
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins (Update for security)
        methods: ["GET", "POST"],
    },
});

let userSockets = {}; // Store user id -> socket id mapping

io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Store user socket mapping when a user connects
    socket.on("registerUser", (userId) => {
        userSockets[userId] = socket.id;
        console.log(`User ${userId} registered with socket ID: ${socket.id}`);
    });

    // Handle sending messages
    // Handle sending messages
    socket.on("sendMessage", (data) => {
        const { senderId, receiverId, text } = data;

        // Check if the receiver is online
        const receiverSocketId = userSockets[receiverId];

        // Insert the message into the database
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

                // Emit the message to the receiver's socket if they are online
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
    socket.on("disconnect", () => {
        for (let userId in userSockets) {
            if (userSockets[userId] === socket.id) {
                delete userSockets[userId]; // Remove user from the mapping
                console.log(`User ${userId} disconnected`);
                break;
            }
        }
    });
});

// Sample route
app.get("/", (req, res) => {
    res.send("Welcome to the Social Media API");
});

// Start the server
server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

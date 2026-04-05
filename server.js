const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { initializeSocket } = require("./socket");

dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.json());

const corsOptions = {
    origin: "*",
    credentials: true,
};
app.use(cors(corsOptions));

// Routes
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const postRoutes = require("./routes/postRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const followRoutes = require("./routes/followRoutes");
const searchRoutes = require("./routes/searchRoute");
const settingsRoutes = require("./routes/settingsRoutes");
const messagesRoutes = require("./routes/messagesRoute");
const storiesRoutes = require("./routes/storiesRoutes");

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/follow", followRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/stories", storiesRoutes);

app.get("/debug/sockets", (req, res) => {
    res.json(getUserSockets());
});

// ✅ Use the shared promise pool from db.js
const { promisePool } = require("./db");

initializeSocket(server, promisePool); // ✅ pass promisePool to socket

server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});

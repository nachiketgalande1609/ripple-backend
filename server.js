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

const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://ripple.nachiketgalande.com",
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || allowedOrigins.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin || "*");
        res.header("Access-Control-Allow-Credentials", "true");
        res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CURRENT-USER-ID");
    }
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

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
const keysRoutes = require("./routes/keysRoute");
const insightsRoutes = require("./routes/insightsRoutes");
const pollRoutes = require("./routes/pollRoutes");
const highlightsRoutes = require("./routes/highlightsRoutes");
const groupsRoutes = require("./routes/groupsRoute");

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/follow", followRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/stories", storiesRoutes);
app.use("/api/keys", keysRoutes);
app.use("/api/insights", insightsRoutes);
app.use("/api/polls", pollRoutes);
app.use("/api/highlights", highlightsRoutes);
app.use("/api/groups", groupsRoutes);

app.get("/debug/sockets", (req, res) => {
    res.json(getUserSockets());
});

// ✅ Use the shared promise pool from db.js
const { promisePool } = require("./db");

initializeSocket(server, promisePool); // ✅ pass promisePool to socket

server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});

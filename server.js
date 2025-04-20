const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { initializeSocket } = require("./socket");
const authMiddleware = require("./middleware/auth");

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

app.use(authMiddleware);

app.use("/api/users", userRoutes);
app.use("/api/follow", followRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/stories", storiesRoutes);

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

// Initialize Socket.io
initializeSocket(server, db);

// Sample route
app.get("/", (req, res) => {
    res.send("Welcome to the Social Media API");
});

// Start the server
// server.listen(port, () => {
//     console.log(`Server running on port ${port}`);
// });

server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});

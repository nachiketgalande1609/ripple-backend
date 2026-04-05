// db.js
const mysql = require("mysql2");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    ssl: {
        ca: fs.readFileSync(path.join(__dirname, "ca.pem")),
    },
});

const promisePool = pool.promise();

module.exports = { pool, promisePool };

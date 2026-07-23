const jwt = require("jsonwebtoken");
const { promisePool: db } = require("../db");

const authMiddleware = async (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];

    if (!token) {
        return res.status(403).json({
            success: false,
            error: "Token is required for this route",
            data: null,
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Check revocation and update last_active
        if (decoded.sid) {
            try {
                const [rows] = await db.query(
                    "SELECT revoked FROM user_sessions WHERE id = ? LIMIT 1",
                    [decoded.sid]
                );
                if (rows.length > 0 && rows[0].revoked === 1) {
                    return res.status(401).json({
                        success: false,
                        error: "Session has been revoked",
                        data: null,
                    });
                }
                if (rows.length > 0) {
                    db.query("UPDATE user_sessions SET last_active = NOW() WHERE id = ?", [decoded.sid]).catch(() => {});
                }
            } catch (err) {
                console.error("[auth] revocation check failed:", err.message);
            }
        }

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            error: "Invalid or expired token",
            data: null,
        });
    }
};

module.exports = authMiddleware;

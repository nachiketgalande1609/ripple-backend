const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1]; // Get token from Authorization header (Bearer <token>)

    if (!token) {
        return res.status(403).json({
            success: false,
            error: "Token is required for this route",
            data: null,
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Attach user data to the request
        next(); // Proceed to the next middleware/route handler
    } catch (err) {
        return res.status(401).json({
            success: false,
            error: "Invalid or expired token",
            data: null,
        });
    }
};

module.exports = authMiddleware;

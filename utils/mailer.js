const nodemailer = require("nodemailer");
require("dotenv").config();

function getTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === "true",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

const sendEmail = async (to, subject, body, html = null) => {
    const mailOptions = {
        from: process.env.SMTP_FROM,
        to,
        subject,
        text: body,
        ...(html && { html }),
    };

    try {
        await getTransporter().sendMail(mailOptions);
        return { success: true, message: "Email sent successfully", error: false };
    } catch (error) {
        console.error("Error sending email:", error);
        return { success: false, message: "Failed to send email", error: true };
    }
};

module.exports = { sendEmail };

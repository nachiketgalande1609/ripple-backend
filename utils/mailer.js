const { Resend } = require("resend");
require("dotenv").config();

const resend = new Resend(process.env.SMTP_PASS);

const sendEmail = async (to, subject, body, html = null) => {
    try {
        await resend.emails.send({
            from: process.env.SMTP_FROM,
            to,
            subject,
            text: body,
            ...(html && { html }),
        });
        return { success: true, message: "Email sent successfully", error: false };
    } catch (error) {
        console.error("Error sending email:", error);
        return { success: false, message: "Failed to send email", error: true };
    }
};

module.exports = { sendEmail };

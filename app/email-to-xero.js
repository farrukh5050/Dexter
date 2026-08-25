import nodemailer from "nodemailer";

export function createSmtpTransport({ user, pass, host, port }) {

    return nodemailer.createTransport({
        host: host,
        port: Number(port),
        auth: {
            user: user,
            pass: pass
        }
    });
}


export async function sendAttachmentToXero({ transporter, senderEmail, attachment, xeroMailbox }) {

    return transporter.sendMail({
        from: senderEmail,
        to: xeroMailbox,
        subject: attachment.filename || "Invoice attachment",
        text: "Invoice attachment submitted automatically.",
        attachments: [
            {
                filename: attachment.filename || "invoice.pdf",
                content: attachment.content,
                contentType: attachment.contentType || "application/pdf"
            }
        ]
    });
}
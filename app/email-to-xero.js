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


/** Pass a document on to a person, with who sent it and what they wrote. */
export async function forwardAttachment({ transporter, senderEmail, to, attachment, parsed, mailbox, ruleName }) {

    return transporter.sendMail({
        from: senderEmail,
        to: to,
        // A reply should reach whoever sent it, not this mailbox.
        replyTo: parsed.from?.text,
        subject: `Fwd: ${parsed.subject || attachment.filename}`,
        text:
            `${ruleName}, received in ${mailbox}.\n\n` +
            `From: ${parsed.from?.text ?? "unknown"}\n` +
            `Date: ${parsed.date ?? "unknown"}\n` +
            `Subject: ${parsed.subject ?? ""}\n\n` +
            (parsed.text ?? ""),
        attachments: [
            {
                filename: attachment.filename || "document.pdf",
                content: attachment.content,
                contentType: attachment.contentType || "application/pdf"
            }
        ]
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
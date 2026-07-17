import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs/promises";
import "dotenv/config";
import path from "path";
import fileToRoute from "./file_router.js";

let uidStore = {};

try {
    uidStore = JSON.parse(
        await fs.readFile("uid.json", "utf8")
    );
} catch {
    uidStore = {};
    await fs.writeFile(
        "uid.json",
        JSON.stringify(uidStore, null, 2)
    );
}

await fs.mkdir("attachments", {
    recursive: true
});

await Promise.all([
    monitorMailbox({
        user: process.env.IMAP_USER_FARAKH,
        pass: process.env.IMAP_PASS_FARAKH
    }),
    monitorMailbox({
        user: process.env.IMAP_USER_MUDASSAR,
        pass: process.env.IMAP_PASS_MUDASSAR
    })
]);

async function monitorMailbox({ user, pass }) {
    let lastUid = uidStore[user] ?? 0;

    const client = new ImapFlow({
        host: "secure.emailsrvr.com",
        port: 993,
        secure: true,
        auth: {
            user,
            pass
        },
        logger: false
    });

    await client.connect();
    await client.mailboxOpen("INBOX");

    // On first run, start watching from the newest existing email
    if (!uidStore[user]) {
        const status = await client.status("INBOX", {
            uidNext: true
        });

        lastUid = status.uidNext - 1;
        uidStore[user] = lastUid;

        await saveUidStore();
    }

    console.log(`Watching ${user} mailbox`);

    client.on("exists", async () => {
        try {
            for await (
                const message of client.fetch(
                    {
                        uid: `${lastUid + 1}:*`
                    },
                    {
                        uid: true,
                        source: true
                    }
                )
            ) {
                // IMAP may return the last message when no newer UID exists
                if (message.uid <= lastUid) {
                    continue;
                }

                const parsed = await simpleParser(message.source);

                const senderEmail =
                    parsed.from?.value?.[0]?.address ?? "";

                const pdfAttachments = parsed.attachments.filter(
                    attachment => {
                        const isAttachment =
                            attachment.contentDisposition ===
                            "attachment";

                        const isPdf =
                            attachment.contentType ===
                                "application/pdf" ||
                            attachment.filename
                                ?.toLowerCase()
                                .endsWith(".pdf");

                        return isAttachment && isPdf;
                    }
                );

                for (const attachment of pdfAttachments) {
                    const result = await fileToRoute(attachment, {
                        from: senderEmail
                    });

                    if (result.status === "matched") {
                        console.log(
                            `Ready to forward ${attachment.filename} ` +
                            `to ${result.company.companyName} ` +
                            `at ${result.company.xeroEmail} ` +
                            `using ${result.matchedBy}`
                        );
                    } else if (result.status === "ocr_required") {
                        console.log(
                            `${attachment.filename} appears to be a scanned PDF`
                        );
                    } else if (result.status === "needs_review") {
                        console.log(
                            `${attachment.filename} could not be matched`
                        );
                    } else if (
                        result.status === "failed_to_process"
                    ) {
                        console.error(
                            `Failed to process ${attachment.filename}:`,
                            result.error
                        );
                    }

                    const safeFilename = path.basename(
                        attachment.filename || "attachment.pdf"
                    );

                    await fs.writeFile(
                        path.join("attachments", safeFilename),
                        attachment.content
                    );

                    console.log(`Saved: ${safeFilename}`);
                }

                lastUid = message.uid;
                uidStore[user] = lastUid;

                await saveUidStore();
            }
        } catch (error) {
            console.error(
                `Failed processing email for ${user}:`,
                error
            );
        }
    });
}

async function saveUidStore() {
    await fs.writeFile(
        "uid.json",
        JSON.stringify(uidStore, null, 2)
    );
}
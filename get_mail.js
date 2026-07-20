import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs/promises";
import "dotenv/config";
import path from "path";
import fileToRoute from "./file_router.js";

let uidStore = {};
let accountConfig;
const jsonPath = new URL("./json_files/uid.json", import.meta.url)

try {
    uidStore = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
} catch {
    uidStore = {};

    await fs.writeFile(
        jsonPath,
        JSON.stringify(uidStore, null, 2)
    );
}

accountConfig = JSON.parse(await fs.readFile(new URL("./json_files/mail_accounts.json", import.meta.url),"utf-8"));

// create and attachments folder
await fs.mkdir(new URL("./attachments", import.meta.url), { recursive: true });

// store a list of accounts to be monitored from the JSON file
const accounts = accountConfig.accounts;

await Promise.all(accounts.map(account => monitorMailbox(account)));


async function monitorMailbox(account) {
    const user = process.env[account.userEnv];
    const pass = process.env[account.passEnv];

    let lastUid = uidStore[user] ?? 0;

    const client = new ImapFlow({
        host: account.host,
        port: account.port,
        secure: account.secure,
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

                        const safeFilename = path.basename(
                            attachment.filename || "attachment.pdf"
                        );

                        await fs.writeFile(
                            path.join("attachments", safeFilename),
                            attachment.content
                        );

                        console.log(`Saved: ${safeFilename}`);
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
        jsonPath,
        JSON.stringify(uidStore, null, 2)
    );
}
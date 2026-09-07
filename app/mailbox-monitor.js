import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs/promises";
import "dotenv/config";
import matchFileRules from "./doc-rule-matcher.js";
import { save_file_matched, save_file_for_review } from "./attachment-storage.js";
import { createSmtpTransport, sendAttachmentToXero } from "./email-to-xero.js"


let uidStore = {};
let uidSaveQueue = Promise.resolve();
const uidStorePath = new URL("../json_files/uid.json", import.meta.url)
const attachmentsPath = new URL("../attachments/", import.meta.url)

try {
    uidStore = JSON.parse(await fs.readFile(uidStorePath, "utf-8"));
} catch {
    uidStore = {};
    await fs.writeFile(
        uidStorePath,
        JSON.stringify(uidStore, null, 2)
    );
}

// create and attachments folder
await fs.mkdir(attachmentsPath, { recursive: true });

const accounts = getAccountsFromEnv();
const smtp_account = getSmtpFromEnv();

const smtpTransporter = createSmtpTransport(smtp_account);

await Promise.allSettled(accounts.map(account => watchAccount(account)));

async function watchAccount(account) {
    let attempt = 0;

    for (; ;) {
        try {
            // Returns when the connection closes.
            await monitorMailbox(account);
            attempt = 0;
        } catch (error) {
            console.error(`Mailbox session failed for ${account.userEnv}:`, error);
            attempt += 1;
        }

        const delay = Math.min(5000 * 2 ** Math.min(attempt, 6), 300_000);

        console.log(`Reconnecting ${account.userEnv} in ${delay / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}


async function monitorMailbox(account) {
    const user = process.env[account.userEnv];
    const pass = process.env[account.passEnv];
    const host = process.env[account.hostEnv];

    const hasSavedUid = Object.hasOwn(uidStore, user);
    let lastUid = uidStore[user] ?? 0;

    const client = new ImapFlow({
        host: host,
        port: 993,
        secure: true,
        socketTimeout: 15 * 60 * 1000,
        auth: {
            user,
            pass
        },
        logger: false
    });

    let onClosed;
    const closed = new Promise(resolve => { onClosed = resolve; });

    client.on("error", error => {
        console.error(`IMAP error for ${user}:`, error);
    });

    client.on("close", () => {
        console.warn(`IMAP connection closed for ${user}`);
        onClosed();
    });

    await client.connect();
    await client.mailboxOpen("INBOX");

    // On first run, start watching from the newest existing email
    if (!hasSavedUid) {
        const status = await client.status("INBOX", { uidNext: true });

        lastUid = status.uidNext - 1;
        uidStore[user] = lastUid;

        await saveUidStore();
    }

    console.log(`Watching ${user} mailbox`);
    let processing = false;
    let processAgain = false;

    client.on("exists", () => {
        processAgain = true;
        void drainMailbox();
    });

    async function processMessage(source) {
        const parsed = await simpleParser(source);

        // Filter out PDF attachments from the email
        const pdfAttachments = parsed.attachments.filter(attachment => {
            const isAttachment = attachment.contentDisposition === "attachment";
            const isPdf = attachment.contentType === "application/pdf" || attachment.filename?.toLocaleLowerCase().endsWith(".pdf");
            return isAttachment && isPdf;
        });

        const senderEmail = parsed.from?.value?.[0]?.address ?? "";

        for (const attachment of pdfAttachments) {
            const result = await matchFileRules(attachment, { from: senderEmail });

            switch (result.status) {
                case "matched":
                    await save_file_matched(user, result, parsed, attachment);
                    await sendAttachmentToXero({
                        transporter: smtpTransporter,
                        senderEmail: smtp_account.user,
                        attachment,
                        xeroMailbox: result.company.xeroEmail
                    });

                    console.log(`Sent ${result.company.companyName}`);

                    break;

                case "ignore":
                    console.log(`Ignored ${attachment.filename}: ${result.rule}`);
                    break;

                case "needs_review":
                case "failed_to_process":
                    await save_file_for_review(user, result, parsed, attachment);
                    console.warn(`Saved ${attachment.filename} for manual review: ${result.status}`);
                    break;

                default:
                    throw new Error(`Unknown status: ${result.status}`);
            }
        }

    }

    async function drainMailbox() {
        if (processing) {
            return;
        }

        processing = true;

        try {
            do {
                processAgain = false;

                // Phase 1: cheap. Ask only for UIDs, so this command is open
                // for milliseconds instead of the whole batch.
                const uids = (await client.search({ uid: `${lastUid + 1}:*` }, { uid: true }))
                    // Some IMAP servers still return the range boundary.
                    .filter(uid => uid > lastUid)
                    .sort((a, b) => a - b);

                for (const uid of uids) {
                    if (!client.usable) {
                        throw new Error("Connection lost while draining mailbox");
                    }

                    // Phase 2: one short download, then all the slow OCR work
                    // runs with no IMAP command left open.
                    const message = await client.fetchOne(
                        String(uid),
                        { source: true },
                        { uid: true }
                    );

                    // A missing message was deleted between search and fetch.
                    if (message) {
                        await processMessage(message.source);
                    }

                    lastUid = uid;
                    uidStore[user] = lastUid;
                    await saveUidStore();
                }
            } while (processAgain);
        } catch (error) {
            console.error(`Failed processing email for ${user}:`, error);
        } finally {
            processing = false;

            if (processAgain) {
                void drainMailbox();
            }
        }
    }

    // Process mail that arrived while the application was offline.
    void drainMailbox();

    // Resolve when the connection drops, so watchAccount can reconnect.
    await closed;
}

async function saveUidStore() {
    const contents = JSON.stringify(uidStore, null, 2);
    const save = uidSaveQueue.then(() => fs.writeFile(uidStorePath, contents));

    // Keep writes from different mailbox monitors in order, while allowing a
    // later save to proceed if an earlier save failed.
    uidSaveQueue = save.catch(() => { });

    return save;
}

function getAccountsFromEnv() {
    const mail_accounts = Object.keys(process.env)
        .filter((key) => key.startsWith("USER_"))
        .sort()
        .map(userEnv => {
            const suffix = userEnv.replace("USER_", "");

            return {
                userEnv,
                passEnv: `PASS_${suffix}`,
                hostEnv: `HOST_${suffix}`,
            };
        });

    if (mail_accounts.length === 0) {
        throw new Error("No USER_* mail accounts found in .env")
    }

    return mail_accounts;
}

function getSmtpFromEnv() {
    return {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT
    }
}

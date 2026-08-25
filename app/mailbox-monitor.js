import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs/promises";
import "dotenv/config";
import matchFileRules from "./document-matcher.js";
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


await Promise.all(accounts.map(account => monitorMailbox(account)));


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
        auth: {
            user,
            pass
        },
        logger: false
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

    async function drainMailbox() {
        if (processing) {
            return;
        }

        processing = true;

        try {
            do {
                processAgain = false;

                for await (
                    const message of client.fetch(
                        { uid: `${lastUid + 1}:*` },
                        { uid: true, source: true }
                    )
                ) {
                    // Some IMAP servers can still return the range boundary.
                    if (message.uid <= lastUid) {
                        continue;
                    }

                    const parsed = await simpleParser(message.source);

                    const pdfAttachments = parsed.attachments.filter(attachment => {
                        const isAttachment = attachment.contentDisposition === "attachment";
                        const isPdf = attachment.contentType === "application/pdf" || attachment.filename?.toLowerCase().endsWith(".pdf");
                        return isAttachment && isPdf;
                    });

                    const senderEmail = parsed.from?.value?.[0]?.address ?? "";

                    for (const attachment of pdfAttachments) {
                        const result = await matchFileRules(attachment, { from: senderEmail });

                        switch (result.status) {
                            case "matched":
                                await save_file_matched(user, result, parsed, attachment);
                                const delivery = await sendAttachmentToXero({
                                    transporter: smtpTransporter,
                                    senderEmail: smtp_account.user,
                                    attachment,
                                    xeroMailbox: result.company.xeroEmail
                                });
                                console.log(
                                    `Sent ${attachment.filename} to Xero: ${delivery.messageId}`
                                );
                                
                                break;

                            case "ignore":
                                console.log(
                                    `Ignored ${attachment.filename}: ${result.rule}`
                                );
                                break;
                            case "needs_review":
                            case "failed_to_process":
                                await save_file_for_review(user, result, parsed, attachment);
                                console.warn(`Saved ${attachment.filename} for manual review` + result.status);
                                break;

                            default:
                                throw new Error(
                                    `Unknown result type: ${result.status}`
                                );
                        }
                    }

                    // Commit only after every attachment has been saved or queued.
                    lastUid = message.uid;
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
                name: suffix.toLowerCase(),
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

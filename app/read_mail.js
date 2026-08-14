import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import fs from "fs/promises";
import "dotenv/config";
import path from "path";
import fileToRoute from "./file_router.js";


let uidStore = {};
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

const accounts = getAccountsFromEnv()

await Promise.all(accounts.map(account => monitorMailbox(account)));


async function monitorMailbox(account) {
    const user = process.env[account.userEnv];
    const pass = process.env[account.passEnv];
    const host = process.env[account.hostEnv];

    const hasSavedUid = Object.hasOwn(uidStore, user);
    const replayAllEmails = hasSavedUid && uidStore[user] === 0;

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

    client.on("exists", async () => {
        try {
            for await (
                const message of client.fetch({ uid: `${lastUid}:*` }, { uid: true, source: true })) {
                // IMAP may return the last message when no newer UID exists
                if (message.uid < lastUid) {
                    continue;
                }

                const parsed = await simpleParser(message.source);

                // extract attachements from email
                const pdfAttachments = parsed.attachments.filter(attachment => {
                    const isAttaschment = attachment.contentDisposition === "attachment";

                    const isPdf = attachment.contentType === "application/pdf" || attachment.filename?.toLowerCase().endsWith(".pdf");

                    return isAttaschment && isPdf;
                });

                // Get sender email address 
                const senderEmail = parsed.from?.value?.[0]?.address ?? "";

                for (const attachment of pdfAttachments) {
                    const result = await fileToRoute(attachment, { from: senderEmail });

                    switch (result.status) {
                        case "matched": {
                            const savedFilename = buildAttachmentFilename({
                                mailbox: user,
                                companyName: result.company.companyName,
                                receivedDate: parsed.date,
                                originalFilename: attachment.filename
                            });

                            await fs.writeFile(new URL(savedFilename, attachmentsPath), attachment.content);

                            console.log(`Saved: ${savedFilename}`);
                            console.log(
                                `Ready to forward ${attachment.filename} ` +
                                `to ${result.company.companyName} ` +
                                `at ${result.company.xeroEmail} ` +
                                `using ${result.matchedBy}`
                            );
                            break;
                        }
                        case "ignore": {
                            console.log(`Ignore ${attachment.filename} because it matched: ${result.rule}`);
                            break;
                        }
                        case "ocr_required": {
                            console.log(`${attachment.filename} appears to be a scanned PDF`);
                            break;
                        }
                        case "needs_review": {
                            console.log(`${attachment.filename} could not be matched`);
                            break;
                        }
                        case "failed_to_process": {
                            console.error(`Failed to process ${attachment.filename}:`, result.error);
                            break;
                        }
                        default: {
                            console.error(`Unknown result type ${result.status}`);
                        }
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

function buildAttachmentFilename({ mailbox, companyName, receivedDate, originalFilename }) {
    const date = receivedDate ? new Date(receivedDate) : new Date();

    const formattedDate = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-");

    const safeMailbox = sanitiseFilenamePart(mailbox.split("@", 1)[0]);

    const safeCompany = sanitiseFilenamePart(companyName);

    const safeOriginalFilename = sanitiseFilenamePart(originalFilename || "attachment.pdf");

    return (
        `${safeMailbox}_` +
        `${safeCompany}_` +
        `${formattedDate}_` +
        `${safeOriginalFilename}`
    );
}

function sanitiseFilenamePart(value = "") {
    return String(value)
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_");
}

async function saveUidStore() {
    await fs.writeFile(
        uidStorePath,
        JSON.stringify(uidStore, null, 2)
    );
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

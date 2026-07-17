import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config as loadEnv } from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import fileToRoute from "./file_router.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const UID_STORE_PATH = path.join(APP_DIR, "uid.json");
const ATTACHMENTS_DIR = path.join(APP_DIR, "attachments");
const FAILED_MESSAGES_DIR = path.join(APP_DIR, "failed-messages");

loadEnv({ path: path.join(APP_DIR, ".env"), quiet: true });

const IMAP_HOST = process.env.IMAP_HOST || "secure.emailsrvr.com";
const IMAP_PORT = readPositiveInteger("IMAP_PORT", 993);
const MAX_MESSAGE_BYTES = readPositiveInteger("MAX_MESSAGE_BYTES", 50 * 1024 * 1024);
const MAX_ATTACHMENT_BYTES = readPositiveInteger("MAX_ATTACHMENT_BYTES", 25 * 1024 * 1024);
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

const accounts = [
    readAccount("FARAKH"),
    readAccount("MUDASSAR")
];

let uidStore = await readUidStore();
let uidWriteQueue = Promise.resolve();
const shutdownController = new AbortController();

await Promise.all([
    fs.mkdir(ATTACHMENTS_DIR, { recursive: true }),
    fs.mkdir(FAILED_MESSAGES_DIR, { recursive: true })
]);

for (const signalName of ["SIGINT", "SIGTERM"]) {
    process.once(signalName, () => {
        log("info", "Shutdown requested", { signal: signalName });
        shutdownController.abort();
    });
}

await Promise.all(
    accounts.map(account => runMailbox(account, shutdownController.signal))
);

async function runMailbox(account, signal) {
    let reconnectDelay = RECONNECT_MIN_MS;

    while (!signal.aborted) {
        const client = new ImapFlow({
            host: IMAP_HOST,
            port: IMAP_PORT,
            secure: true,
            auth: { user: account.user, pass: account.pass },
            logger: false
        });
        const connectedAt = Date.now();
        const closeOnAbort = () => client.close();
        signal.addEventListener("abort", closeOnAbort, { once: true });

        try {
            await monitorConnection(client, account, signal);
        } catch (error) {
            if (!signal.aborted) {
                log("error", "Mailbox connection failed", {
                    mailbox: account.user,
                    error: errorMessage(error)
                });
            }
        } finally {
            signal.removeEventListener("abort", closeOnAbort);
            client.close();
        }

        if (signal.aborted) break;

        if (Date.now() - connectedAt >= 60_000) {
            reconnectDelay = RECONNECT_MIN_MS;
        }

        log("warn", "Reconnecting mailbox", {
            mailbox: account.user,
            delayMs: reconnectDelay
        });
        await abortableDelay(reconnectDelay, signal);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
}

async function monitorConnection(client, account, signal) {
    client.on("error", error => {
        log("error", "IMAP client error", {
            mailbox: account.user,
            error: errorMessage(error)
        });
    });

    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX");
    let lastUid = await initialiseCheckpoint(account.user, mailbox);
    let drainRequested = false;
    let activeDrain = null;

    const scheduleDrain = () => {
        drainRequested = true;
        if (activeDrain) return;

        activeDrain = drainMailbox()
            .catch(error => {
                log("error", "Mailbox processing failed; reconnecting", {
                    mailbox: account.user,
                    error: errorMessage(error)
                });
                client.close();
            })
            .finally(() => {
                activeDrain = null;
                if (drainRequested && client.usable && !signal.aborted) {
                    scheduleDrain();
                }
            });
    };

    const drainMailbox = async () => {
        while (drainRequested && client.usable && !signal.aborted) {
            drainRequested = false;

            for await (const message of client.fetch(
                { uid: `${lastUid + 1}:*` },
                { uid: true, source: true }
            )) {
                if (message.uid <= lastUid) continue;

                await processOrQuarantineMessage(account.user, message);
                lastUid = message.uid;
                uidStore[account.user] = {
                    uid: lastUid,
                    uidValidity: mailbox.uidValidity.toString()
                };
                await persistUidStore();
            }
        }
    };

    client.on("exists", scheduleDrain);
    scheduleDrain();

    log("info", "Watching mailbox", {
        mailbox: account.user,
        lastUid
    });

    await waitForClose(client, signal);
    await activeDrain?.catch(() => {});
}

async function initialiseCheckpoint(user, mailbox) {
    const currentUidValidity = mailbox.uidValidity.toString();
    const saved = normaliseCheckpoint(uidStore[user]);

    if (!saved || (saved.uidValidity && saved.uidValidity !== currentUidValidity)) {
        const lastUid = Math.max(0, mailbox.uidNext - 1);

        if (saved?.uidValidity) {
            log("warn", "Mailbox UIDVALIDITY changed; starting from new mail", {
                mailbox: user,
                previousUidValidity: saved.uidValidity,
                currentUidValidity
            });
        }

        uidStore[user] = { uid: lastUid, uidValidity: currentUidValidity };
        await persistUidStore();
        return lastUid;
    }

    uidStore[user] = {
        uid: saved.uid,
        uidValidity: currentUidValidity
    };
    await persistUidStore();
    return saved.uid;
}

async function processOrQuarantineMessage(user, message) {
    try {
        await processMessage(user, message);
    } catch (error) {
        const failedFilename = `${safePathPart(user)}-${message.uid}.eml`;
        const failedPath = path.join(FAILED_MESSAGES_DIR, failedFilename);

        if (!message.source) {
            throw new Error(
                `Message ${message.uid} failed and could not be quarantined: ${errorMessage(error)}`
            );
        }

        await writeFileAtomically(failedPath, message.source);
        log("error", "Message quarantined", {
            mailbox: user,
            uid: message.uid,
            file: failedFilename,
            error: errorMessage(error)
        });
    }
}

async function processMessage(user, message) {
    if (!message.source) {
        throw new Error("IMAP server returned a message without source data");
    }
    if (message.source.length > MAX_MESSAGE_BYTES) {
        throw new Error(`Message exceeds the ${MAX_MESSAGE_BYTES}-byte size limit`);
    }

    const parsed = await simpleParser(message.source, {
        skipHtmlToText: true,
        skipTextToHtml: true
    });
    const senderEmail = parsed.from?.value?.[0]?.address ?? "";
    const pdfAttachments = parsed.attachments.filter(attachment => {
        const isNotInline = attachment.contentDisposition !== "inline";
        const isPdf = attachment.contentType?.toLowerCase() === "application/pdf" ||
            attachment.filename?.toLowerCase().endsWith(".pdf");
        return isNotInline && isPdf;
    });

    for (const [index, attachment] of pdfAttachments.entries()) {
        if (!attachment.content || attachment.content.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(
                `PDF attachment ${attachment.filename || index + 1} is empty or exceeds the ` +
                `${MAX_ATTACHMENT_BYTES}-byte size limit`
            );
        }

        const originalName = sanitiseFilename(attachment.filename || `attachment-${index + 1}.pdf`);
        const storedName = `${safePathPart(user)}-${message.uid}-${index + 1}-${originalName}`;
        await writeFileAtomically(
            path.join(ATTACHMENTS_DIR, storedName),
            attachment.content
        );

        const result = await fileToRoute(attachment, { from: senderEmail });
        logRoutingResult(user, message.uid, storedName, result);
    }

    log("info", "Message processed", {
        mailbox: user,
        uid: message.uid,
        pdfAttachments: pdfAttachments.length
    });
}

function logRoutingResult(user, uid, filename, result) {
    const context = { mailbox: user, uid, file: filename };

    switch (result.status) {
        case "matched":
            log("info", "PDF matched", {
                ...context,
                company: result.company.companyName,
                destination: result.company.xeroEmail,
                matchedBy: result.matchedBy
            });
            break;
        case "ocr_required":
            log("warn", "PDF requires OCR", context);
            break;
        case "needs_review":
            log("warn", "PDF needs manual review", context);
            break;
        case "failed_to_process":
            log("error", "PDF processing failed", {
                ...context,
                error: result.error
            });
            break;
        default:
            log("error", "Router returned an unknown status", {
                ...context,
                status: result.status
            });
    }
}

async function readUidStore() {
    try {
        const contents = await fs.readFile(UID_STORE_PATH, "utf8");
        const parsed = JSON.parse(contents);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("uid.json must contain a JSON object");
        }
        return parsed;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return {};
    }
}

function persistUidStore() {
    const write = uidWriteQueue.then(async () => {
        const temporaryPath = `${UID_STORE_PATH}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(uidStore, null, 2)}\n`, "utf8");
        await fs.rename(temporaryPath, UID_STORE_PATH);
    });
    uidWriteQueue = write.catch(() => {});
    return write;
}

async function writeFileAtomically(targetPath, contents) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, targetPath);
}

function normaliseCheckpoint(value) {
    if (Number.isSafeInteger(value) && value >= 0) {
        return { uid: value, uidValidity: null };
    }
    if (!value || !Number.isSafeInteger(value.uid) || value.uid < 0) {
        return null;
    }
    return {
        uid: value.uid,
        uidValidity: value.uidValidity ? String(value.uidValidity) : null
    };
}

function readAccount(name) {
    const user = process.env[`IMAP_USER_${name}`]?.trim();
    const pass = process.env[`IMAP_PASS_${name}`];
    if (!user || !pass) {
        throw new Error(`IMAP_USER_${name} and IMAP_PASS_${name} are required`);
    }
    return { user, pass };
}

function readPositiveInteger(name, fallback) {
    const rawValue = process.env[name];
    if (rawValue === undefined || rawValue === "") return fallback;

    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function sanitiseFilename(filename) {
    const basename = path.basename(filename)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 180);
    return basename || "attachment.pdf";
}

function safePathPart(value) {
    return value.toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 80);
}

function waitForClose(client, signal) {
    return new Promise(resolve => {
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            signal.removeEventListener("abort", onAbort);
            client.removeListener("close", finish);
            resolve();
        };
        const onAbort = () => {
            client.close();
            finish();
        };

        client.once("close", finish);
        signal.addEventListener("abort", onAbort, { once: true });

        if (signal.aborted) onAbort();
        else if (!client.usable) finish();
    });
}

function abortableDelay(milliseconds, signal) {
    return new Promise(resolve => {
        const timeout = setTimeout(finish, milliseconds);
        const onAbort = () => finish();

        function finish() {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            resolve();
        }

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish();
    });
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function log(level, message, context = {}) {
    const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...context
    });
    const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    output(entry);
}

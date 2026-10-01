import fs from "fs/promises";
import { createHash } from "crypto";

const attachmentsPath = new URL("../attachments/", import.meta.url);

const reviewPath = new URL("../attachments/review/", import.meta.url);

// status|hash of every review file written this run. Checked and filled before
// any await, because two mailboxes often receive the same email in the same
// second and both would pass the directory check.
const reviewHashes = new Set();

export async function save_file_matched(user, result, parsed, attachment) {
    await fs.mkdir(attachmentsPath, { recursive: true });

    const savedFilename = buildAttachmentFilename({
        mailbox: user,
        companyName: result.company.companyName,
        receivedDate: parsed.date,
        originalFilename: attachment.filename
    });

    await fs.writeFile(
        new URL(savedFilename, attachmentsPath),
        attachment.content
    );

    // console.log(`Saved: ${savedFilename}`);
    // console.log(`Ready to forward ${attachment.filename} ` + `to ${result.company.companyName} ` + `at ${result.company.xeroEmail} ` + `using ${result.matchedBy}`);
}

export async function save_file_for_review(user, result, parsed, attachment) {
    const status = sanitiseFilenamePart(result.status);
    const statusPath = new URL(`${status}/`, reviewPath);

    // The same PDF sent to several mailboxes, or chased again, is one thing
    // for a human to look at, not one per copy.
    const hash = createHash("sha256").update(attachment.content).digest("hex").slice(0, 12);

    if (reviewHashes.has(`${status}|${hash}`)) {
        console.log(`Already held for review: ${attachment.filename} (${hash})`);

        return;
    }

    reviewHashes.add(`${status}|${hash}`);

    await fs.mkdir(statusPath, { recursive: true });

    // The hash lives in the filename so the check survives a restart.
    if ((await fs.readdir(statusPath)).some(name => name.includes(hash))) {
        console.log(`Already held for review: ${attachment.filename} (${hash})`);

        return;
    }

    const savedFilename = buildAttachmentFilename({
        mailbox: user,
        companyName: status,
        receivedDate: parsed.date,
        originalFilename: attachment.filename
    }).replace(/(\.pdf)?$/i, `_${hash}$1`);

    console.log(
        "Saving review file:",
        JSON.stringify(savedFilename)
    );

    await fs.writeFile(
        new URL(savedFilename, statusPath),
        attachment.content
    );
}

function buildAttachmentFilename({ mailbox, companyName, receivedDate, originalFilename }) {
    const parsedDate = receivedDate
        ? new Date(receivedDate)
        : new Date();

    const date = Number.isNaN(parsedDate.getTime())
        ? new Date()
        : parsedDate;

    const formattedDate = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-");

    const safeMailbox =
        sanitiseFilenamePart(mailbox.split("@", 1)[0]);

    const safeCompany =
        sanitiseFilenamePart(companyName);

    const safeOriginalFilename =
        sanitiseFilenamePart(
            originalFilename || "attachment.pdf"
        );

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
        .replace(/[<>:"/\\|?*%#\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_");
}

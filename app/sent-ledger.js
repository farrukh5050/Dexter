/*
 * One entry per document already emailed to Xero, so the same invoice cannot
 * be billed twice - whether the supplier chases it, a colleague forwards it,
 * or a part-processed message replays after a crash.
 *
 * Identity is supplier + document type + invoice number. A document with no
 * readable invoice number falls back to a hash of its bytes, which is exactly
 * the forwarded-attachment case.
 */

import fs from "fs/promises"
import { createHash } from "crypto"
import { readInvoiceNumber } from "./doc-splitter.js"

const defaultLedgerPath = new URL("../json_files/sent-invoices.json", import.meta.url);

// Only the smoke test passes a path, so it never writes into the real ledger.
let ledgerPath = defaultLedgerPath;

// Nothing arriving now can be a duplicate of something this old, and the whole
// file is read on every start.
const KEEP_MONTHS = 18;

let ledger = {}
let saveQueue = Promise.resolve();

export async function loadLedger(path = defaultLedgerPath) {
    ledgerPath = path;

    try {
        ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));

    } catch {
        ledger = {};
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);

    ledger = Object.fromEntries(
        Object.entries(ledger).filter(([, entry]) => new Date(entry.sentAt) > cutoff)
    );
}


/** supplier|type|invoice number, or the file's hash when it carries no number. */
export function ledgerKey(result, document, invoiceNumberPatterns = []) {
    const invoiceNo = readInvoiceNumber(document.text ?? "", invoiceNumberPatterns);

    return invoiceNo
        ? `${result.company.companyName}|${result.documentRule ?? "document"}|${invoiceNo}`
        : `sha|${createHash("sha256").update(document.content).digest("hex")}`;
}

export function alreadySent(key) {
    return ledger[key];
}

export async function recordSent(key, { mailbox, filename, uid }) {
    ledger[key] = { sentAt: new Date().toISOString(), mailbox, filename, uid };

    const contents = JSON.stringify(ledger, null, 2);
    const save = saveQueue.then(() => fs.writeFile(ledgerPath, contents));

    // Keep writes from different mailbox monitors in order, while allowing a
    // later save to proceed if an earlier save failed.
    saveQueue = save.catch(() => { });

    return save;
}
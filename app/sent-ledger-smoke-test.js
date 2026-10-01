/*
 * node app/sent-ledger-smoke-test.js
 *
 * Duplicate detection with no mailbox and no PDF.
 */

import assert from "assert";
import fs from "fs/promises";
import { alreadySent, ledgerKey, loadLedger, recordSent } from "./sent-ledger.js";

const patterns = JSON.parse(
    await fs.readFile(new URL("../json_files/company_aliases.json", import.meta.url), "utf-8")
).containerRules.split.invoiceNumberPatterns;

const acme = { company: { companyName: "Acme Ltd" }, documentRule: "invoice" };
const beta = { company: { companyName: "Beta Ltd" }, documentRule: "invoice" };
const document = text => ({ text, content: Buffer.from(text), filename: "bill.pdf" });

const key = ledgerKey(acme, document("Invoice No: AB1234 total 10.00"), patterns);

assert.equal(
    key,
    ledgerKey(acme, document("REMINDER: Invoice No: AB1234 is now overdue"), patterns),
    "a chase for an invoice must key the same as the invoice"
);

assert.notEqual(
    key,
    ledgerKey(beta, document("Invoice No: AB1234"), patterns),
    "the same number from a different supplier is a different invoice"
);

const forwarded = "statement of account, no invoice number anywhere";

assert.equal(
    ledgerKey(acme, document(forwarded), patterns),
    ledgerKey(acme, document(forwarded), patterns),
    "a forwarded copy of the same file must key the same"
);

assert.ok(ledgerKey(acme, document(forwarded), patterns).startsWith("sha|"));

// A throwaway ledger, so a test run never touches the real one.
const testLedger = new URL("./sent-ledger-smoke-test.tmp.json", import.meta.url);

await fs.rm(testLedger, { force: true });

await loadLedger(testLedger);
assert.ok(!alreadySent(key), "nothing is sent before it is recorded");

await recordSent(key, { mailbox: "ap@example.com", filename: "bill.pdf", uid: 7 });
assert.ok(alreadySent(key), "a recorded document is a duplicate next time");

await loadLedger(testLedger);
assert.ok(alreadySent(key), "the ledger survives a restart");

await fs.rm(testLedger, { force: true });

console.log("sent-ledger: ok");

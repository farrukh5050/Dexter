/*
 * node app/doc-splitter-smoke-test.js
 *
 * Filename rules and page grouping, straight from the live config. No PDF.
 */

import assert from "assert";
import fs from "fs/promises";
import triageContainer, { ignoredByFilename } from "./doc-splitter.js";

const containerRules = JSON.parse(
    await fs.readFile(new URL("../json_files/company_aliases.json", import.meta.url), "utf-8")
).containerRules;

// Separators must not matter: the same document arrives as BACS_AUTOPAY.pdf
// from one sender and "BACS Autopay.pdf" from the next.
for (const filename of [
    "BACS_AUTOPAY_2026-09.pdf",
    "bacs-autopay.pdf",
    "Weekly BACS Autopay listing.pdf"
]) {
    assert.equal(ignoredByFilename(filename, containerRules), "bacs autopay", filename);
}

assert.equal(ignoredByFilename("Repayment_Report_November.pdf", containerRules), "repayment report");
assert.equal(ignoredByFilename("invoice_12345.pdf", containerRules), null, "a real invoice must be read");
assert.equal(ignoredByFilename("BACS_AUTOPAY.pdf", {}), null, "no rules configured, nothing ignored");

// Page grouping: a "page 1 of n" marker and a new invoice number each start a
// document, so this is two documents, not three pages of one.
const page = (num, text) => ({ num, text });

const triage = triageContainer({
    pages: [
        page(1, "Page 1 of 2 INVOICE NO: AB1234 widgets"),
        page(2, "continued Total Due 130.00"),
        page(3, "Page 1 of 1 Invoice No: CD5678 Total 42.00")
    ],
    filename: "batch.pdf"
}, containerRules);

assert.equal(triage.action, "split", triage.reason);
assert.deepEqual(triage.groups, [[1, 2], [3]], JSON.stringify(triage.groups));

// A handwritten cover note ahead of two invoices that say "Page 1/1" and
// "£130.00 due by": the note is held back, each invoice is its own document.
const invoice = (num, no, amount) =>
    page(num, `Invoice number ${no}\n£${amount} due by 03 Sep 2026\nPage 1/1`);

const withCover = triageContainer({
    pages: [page(1, "yr C—O —- we = Bloowfieto"), invoice(2, "INVOICE-060", "130.00"), invoice(3, "INVOICE-061", "195.00")]
}, containerRules);

assert.equal(withCover.action, "split", withCover.reason);
assert.deepEqual(withCover.groups, [[2], [3]]);
assert.deepEqual(withCover.coverPages, [1]);

// A cover note ahead of a single invoice is not a batch: nothing is cut.
const coverAndOne = triageContainer({
    pages: [page(1, "scrawl"), page(2, "Page 1 of 2 Invoice number INVOICE-062"), page(3, "Page 2 of 2 £40.00 due by")]
}, containerRules);

assert.notEqual(coverAndOne.action, "split", coverAndOne.reason);

// A scan of one-page garage invoices whose numbers the OCR lost: no boundary
// is readable, but a total on every page means it must not go out as one bill.
const unreadable = triageContainer({
    pages: [page(1, "Labour 0.00 Owing 613.74"), page(2, "Total 42.00"), page(3, "Owing 57.26")]
}, containerRules);

assert.equal(unreadable.action, "review", unreadable.reason);

assert.throws(
    () => triageContainer({ pages: [page(1, "x"), page(2, "y"), page(3, "z")] }, {}),
    /containerRules.split is missing/,
    "a missing split block is a broken install, not a reason to guess"
);

console.log("doc-splitter: ok");

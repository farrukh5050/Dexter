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

assert.throws(
    () => triageContainer({ pages: [page(1, "x"), page(2, "y"), page(3, "z")] }, {}),
    /containerRules.split is missing/,
    "a missing split block is a broken install, not a reason to guess"
);

console.log("doc-splitter: ok");

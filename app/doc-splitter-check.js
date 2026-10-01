/*
 * Self-check for the splitting rules. No PDF, no mailbox, no framework.
 *
 *   node app/doc-splitter-check.js
 *
 * Exits non-zero the moment a boundary rule stops behaving.
 */

import assert from "assert";
import fs from "fs/promises";
import triageContainer from "./doc-splitter.js";

// The shipped patterns, not a copy of them, so this also fails when the config
// is edited into something that stops recognising an invoice.
const config = JSON.parse(
    await fs.readFile(new URL("../json_files/company_aliases.json", import.meta.url), "utf-8")
);

const rules = { split: config.containerRules.split };

const page = (num, text) => ({ num, text });

// Three self-contained invoices: each names itself and ends on a total.
const batch = triageContainer({
    pages: [
        page(1, "Invoice No: INV-1001\nWidgets\nTotal Due £10.00"),
        page(2, "Invoice No: INV-1002\nWidgets\nTotal Due £20.00"),
        page(3, "Invoice No: INV-1003\nWidgets\nTotal Due £30.00")
    ]
}, rules);

assert.strictEqual(batch.action, "split", "a clean 3-invoice batch should split");
assert.deepStrictEqual(batch.groups, [[1], [2], [3]]);

// An invoice number has to carry a digit. Without that rule the capture takes
// the next word - "NOT", "NONE" - and two pages of one document look like two
// documents with different numbers.
const wordy = triageContainer({
    pages: [
        page(1, "Invoice No: not supplied\nTotal Due £10.00"),
        page(2, "Invoice No: none given\nmore lines"),
        page(3, "continued")
    ]
}, rules);

assert.strictEqual(wordy.action, "process", "word captures must not create boundaries");
assert.deepStrictEqual(wordy.groups, [[1, 2, 3]]);

// A group has to END on its totals block. Here the second document totals on
// its first page and then picks up a trailing page, so the boundary is wrong
// and the container must go to a human whole.
const trailing = triageContainer({
    pages: [
        page(1, "Invoice No: INV-2001\nTotal Due £10.00"),
        page(2, "Invoice No: INV-2002\nTotal Due £20.00"),
        page(3, "delivery notes attached")
    ]
}, rules);

assert.strictEqual(trailing.action, "review", "a group not ending on totals is not clean");
assert.deepStrictEqual(trailing.groups, [[1, 2, 3]]);

// Report rules win over everything and discard the container whole.
const report = triageContainer(
    { pages: [page(1, "Trip Stop Report"), page(2, "x"), page(3, "y")] },
    { ...rules, reports: [{ name: "Trip Stop Report", require: ["trip stop report"] }] }
);

assert.strictEqual(report.action, "ignore");

// A chase bundle is held, never posted, however clean its boundaries look.
const chase = triageContainer(
    {
        filename: "MAY INVOICES OUTSTANDING.pdf",
        pages: [
            page(1, "Invoice No: INV-3001\nTotal Due £10.00"),
            page(2, "Invoice No: INV-3002\nTotal Due £20.00"),
            page(3, "Invoice No: INV-3003\nTotal Due £30.00")
        ]
    },
    { ...rules, chases: [{ name: "Chase", matchOn: "filename", anyOf: ["outstanding"] }] }
);

assert.strictEqual(chase.action, "review", "a chase must never auto-post");

console.log("doc-splitter: all checks passed");

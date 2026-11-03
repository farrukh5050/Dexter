/*
 * node app/doc-rule-matcher-smoke-test.js
 *
 * Forward rules, straight from the live config. No PDF, nothing sent.
 */

import assert from "assert";
import { findForwardRule } from "./doc-rule-matcher.js";

const forwardedAs = text => findForwardRule(text)?.name ?? null;

assert.equal(
    forwardedAs("REMITTANCE ADVICE Supplier Number: 216926 Payment Date: 14/10/2026 Invoice Date Your Invoice No."),
    "Remittance Advice"
);

assert.equal(
    forwardedAs("Official Purchase Order No: 000045833 Order Details: Order Totals: CONDITIONS OF ORDER Invoice Address"),
    "Purchase Order"
);

// An invoice with a remittance slip at the foot is still an invoice.
assert.equal(
    forwardedAs("Invoice Number 60177642 Invoice Date 10/09/2026 REMITTANCE ADVICE please return with payment, BACS"),
    null
);

// An invoice with a PO number field is still an invoice.
assert.equal(
    forwardedAs("Invoice Number 0010031463 Tax Point Date Purchase Order No. Order Number 4411"),
    null
);

// A landlord's demand carries a remittance slip but is a bill.
assert.equal(
    forwardedAs("Application For Payment ** THIS IS NOT A TAX INVOICE ** REMITTANCE ADVICE Amount Paid BACS"),
    null
);

console.log("doc-rule-matcher: ok");

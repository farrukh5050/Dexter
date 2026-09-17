/*
 * Run the whole decision path on one local PDF, printing each stage.
 *
 *   node app/pdf-ocr-smoke-test.js <file.pdf> [sender@example.com]
 *
 * Nothing is sent, saved or emailed - this only reads and reports.
 */

import fs from "fs/promises";
import path from "path";
import matchFileRules from "./doc-rule-matcher.js";
import readPdfText, { pagesText } from "./pdf-text.js";
import triageContainer from "./doc-splitter.js";
import { terminateOcrWorker } from "./pdf-ocr.js";

const pdfPath = process.argv[2];
const senderEmail = process.argv[3] ?? "";

if (!pdfPath) {
    console.error("Usage: node app/pdf-ocr-smoke-test.js <file.pdf> [sender@example.com]");
    process.exit(1);
}

const config = JSON.parse(
    await fs.readFile(
        new URL("../json_files/company_aliases.json", import.meta.url),
        "utf-8"
    )
);

const containerRules = config.containerRules ?? {};

const filename = path.basename(pdfPath);
const content = await fs.readFile(pdfPath);
const file = { content, filename, name: filename };

// ── stage: read text, per page ───────────────────────────────────────────────
const container = await readPdfText(file);

console.log("\n=== Text ===");
console.log(`pages: ${container.total}`);
console.log(`source: ${container.textSource}`);
console.log(`useful chars: ${container.usefulChars}`);

for (const page of container.pages) {
    const chars = page.text.replace(/\s+/g, "").length;
    console.log(`  page ${page.num}: ${chars} chars via ${page.textSource}`);
}

// ── stage: what does this container hold ─────────────────────────────────────
const triage = triageContainer(
    { pages: container.pages, filename },
    containerRules
);

console.log("\n=== Container ===");
console.log(`kind:   ${triage.kind}`);
console.log(`action: ${triage.action}`);
console.log(`reason: ${triage.reason}`);
console.log(`groups: ${triage.groups.map(group => `[${group.join(",")}]`).join(" ") || "none"}`);

if (triage.action === "ignore") {
    console.log("\nWould be discarded. Nothing else runs.");
    await terminateOcrWorker();
    process.exit(0);
}

// ── stage: match each document the container turned out to hold ──────────────
console.log("\n=== Documents ===");

for (const [index, pageNumbers] of triage.groups.entries()) {
    const text = pagesText(container, pageNumbers);

    const result = await matchFileRules(
        { ...file, text },
        { from: senderEmail }
    );

    const { file: _file, text: _text, ...details } = result;

    console.log(`\n--- document ${index + 1} of ${triage.groups.length}, pages [${pageNumbers.join(",")}] ---`);
    console.dir(details, { depth: null });
}

if (triage.action === "review") {
    console.log("\nWould be held for review before any of the above is sent.");
}

if (triage.groups.length > 1 && !containerRules.autoSendSplit) {
    console.log("\nSplit documents would be saved but NOT emailed: containerRules.autoSendSplit is off.");
}

await terminateOcrWorker();

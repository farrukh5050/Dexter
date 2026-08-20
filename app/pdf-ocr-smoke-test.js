import fs from "fs/promises";
import path from "path";
import matchFileRules from "./document-matcher.js";

const pdfPath = process.argv[2] ?? "C:/Users/User/Desktop/mudassar_needs_review_2026-08-04_Your-Finance-Solutions-Limited.-_Invoice_046.pdf";
const senderEmail = process.argv[3] ?? "";
const filename = path.basename(pdfPath);
const content = await fs.readFile(pdfPath);

const result = await matchFileRules(
    { content, filename, name: filename },
    { from: senderEmail }
);

const { file, text, ...matchDetails } = result;

console.log("Match result:");
console.dir(matchDetails, { depth: null });
console.log("Text:");
console.log(text ?? "");
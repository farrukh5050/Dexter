import fs from "fs/promises";
import { PDFParse } from 'pdf-parse';

// load all company alias json
const configUrl = new URL("./json_files/company_aliases.json", import.meta.url);
const config = JSON.parse(await fs.readFile(configUrl, "utf-8"));

// Build a map of sender email + which company this sender email to 
const senderLookup = new Map(
    Object.entries(config.senderRules).map(([domain, companyId]) => [
        domain.toLowerCase(),
        config.companies.find(c => c.id === companyId)
    ])
        .filter(([, company]) => company
        )
);

export default async function fileToRoute(file, { from } = {}) {
    if (!file || !file.content) {
        return {
            status: "failed_to_process",
            file,
            error: "The file has no content to process"
        };
    }

    const senderMatch = findCompanyFromSender(file, from);
    if (senderMatch) return senderMatch;

    let parser;

    try {
        parser = new PDFParse({ data: file.content });
        const result = await parser.getText();
        const text = result.text ?? "";

        // const accountMatch = findCompanyFromSupplierAccount(file, text);
        // if (accountMatch) return accountMatch;

        const pdfMatch = findCompanyFromPDF(file, text);
        if (pdfMatch) return pdfMatch;

        return {
            status: "needs_review",
            file,
            text
        };
    } catch (error) {
        return {
            status: "failed_to_process",
            file,
            error: error.message
        };
    } finally {
        if (parser) {
            await parser.destroy().catch(() => {});
        }
    }
}

function findCompanyFromPDF(file, text) {
    if (!hasUsefulText(text)) {
        return {
            status: "ocr_required",
            file,
            text
        };
    }

    const match = findCompanyFromText(text);

    if (!match) {
        return null;
    }

    return {
        status: "matched",
        file,
        text,
        company: match.company,
        matchedBy: "pdf_alias",
        matchedAlias: match.alias
    };
}

function findCompanyFromSender(file, senderEmail = "") {
    if (typeof senderEmail !== "string" || !senderEmail.trim()) return null;

    const addressMatch = senderEmail.trim().toLowerCase().match(/<?([^<>\s@]+@([^<>\s@]+))>?$/);
    const senderDomain = addressMatch?.[2]?.replace(/\.$/, "");
    if (!senderDomain) return null;

    for (const [rule, company] of senderLookup) {
        if (senderDomain === rule ||
            senderDomain.endsWith("." + rule)) {
            return {
                status: "matched",
                file,
                company,
                matchedBy: "sender_rule",
                matchedValue: rule
            };
        }
    }

    return null;
}

function findCompanyFromText(text) {
    const normalisedText = normaliseText(text);

    for (const company of config.companies) {
        for (const alias of company.names) {
            if (normalisedText.includes(normaliseText(alias))) {
                return {
                    company,
                    alias,
                };
            }
        }
    }
}


// check to see if the email is for an invoice or a statement.
function isStatement(text){

}

// detect if the customer is email sales invoice to discuss discrencies with us
function isOwnInvoice(text){

}

function hasUsefulText(text) {
    const cleaned = text
        .replace(/\s+/g, "")
        .replace(/[^\p{L}\p{N}]/gu, "");

    return cleaned.length >= 30;
}

function normaliseText(value = "") {
    return value
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/\blimited\b/g, "ltd")
        .replace(/[^a-z0-9]/g, "");
}

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
    ]).filter(([, company]) => company));

const ruleMap = Object.fromEntries(config.documentRules.map(r => [r.name, r]));
const supplierAccountLookup = [];

for (const [supplierDomain, companies] of Object.entries(config.supplierAccounts ?? {})) {
    for (const [companyId, accounts] of Object.entries(companies)) {
        const company = config.companies.find(company => company.id === companyId);

        if (!company) {
            console.warn(`Unknown company ID "${companyId}"`);

            continue;
        }

        for (const account of accounts) {
            supplierAccountLookup.push({
                supplierDomain: supplierDomain.toLowerCase(),
                accountNumber: normaliseText(account),
                company
            });
        }
    }
}


export default async function fileToRoute(file, { from } = {}) {
    if (!file || !file.content) {
        return {
            status: "failed_to_process",
            file,
            error: "The file has no content to process"
        };
    }

    let parser;

    try {
        parser = new PDFParse({ data: file.content });
        const result = await parser.getText();
        const text = result.text ?? "";
        const normalisedText = normaliseText(text);

        for (const rule of Object.values(ruleMap)) {
            let matchCount = 0;
            for (const check of rule.rules) {
                if (
                    check.match === "contains" &&
                    normalisedText.includes(normaliseText(check.text))
                ) {
                    matchCount++;
                }
            }

            if (matchCount >= rule.matchThreshold &&
                rule.action === "ignore"
            ) {
                return {
                    status: "ignore",
                    file,
                    text,
                    rule: rule.name,
                    matchCount
                };
            }
        }

        const supplierAccountMatch = findCompanyFromSupplierAccount(file, text, from);
        if (supplierAccountMatch) return supplierAccountMatch;

        const pdfMatch = findCompanyFromPDF(file, text);
        if (pdfMatch) return pdfMatch;

        // check for a sender email match first
        const senderMatch = findCompanyFromSender(file, from);
        if (senderMatch) return senderMatch;

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
            await parser.destroy().catch(() => { });
        }
    }
}


function findCompanyFromSender(file, senderEmail = "") {
    const senderDomain = getSenderDomain(senderEmail);

    if (!senderDomain) {
        return null;
    }

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

function findCompanyFromPDF(file, text) {
    const normalisedText = normaliseText(text);

    if (!hasUsefulText(text)) {
        return {
            status: "ocr_required",
            file,
            text
        };
    }

    const match = findCompanyFromText(normalisedText);

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

function findCompanyFromText(text) {
    for (const company of config.companies) {
        for (const alias of company.names) {
            if (text.includes(normaliseText(alias))) {
                return {
                    company,
                    alias,
                };
            }
        }
    }
    return null;
}

function findCompanyFromSupplierAccount(file, text, senderEmail = "") {
    const senderDomain = getSenderDomain(senderEmail);

    if (!senderDomain) {
        return null;
    }

    const normalisedText = normaliseText(text);

    for (const supplier of supplierAccountLookup) {
        const senderMatches = senderDomain === supplier.supplierDomain || senderDomain.endsWith("." + supplier.supplierDomain);;

        if (!senderMatches) {
            continue;
        }

        if (normalisedText.includes(supplier.accountNumber)) {
            return {
                status: "matched",
                file,
                company: supplier.company,
                matchedBy: "supplier_account",
                matchedValue: supplier.accountNumber
            };
        }
    }

    return null;
}

function getSenderDomain(senderEmail = "") {
    if (typeof senderEmail !== "string" || !senderEmail.trim()) {
        return null;
    }

    const addressMatch = senderEmail
        .trim()
        .toLowerCase()
        .match(/<?([^<>\s@]+@([^<>\s@]+))>?$/);

    return addressMatch?.[2]?.replace(/\.$/, "") ?? null;
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

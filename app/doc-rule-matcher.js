import fs from "fs/promises";
import readPdfText from "./pdf-text.js";

// Load company aliases and routing rules
const config = JSON.parse(await fs.readFile(new URL("../json_files/company_aliases.json", import.meta.url), "utf-8"));

// Build sender-domain lookup
const senderLookup = new Map(
    Object.entries(config.senderRules ?? {})
        .map(([domain, companyId]) => [
            domain.toLowerCase(),
            config.companies.find(
                company => company.id === companyId
            )
        ])
        .filter(([, company]) => company)
);

// Keep document rules in their configured order and do not collapse duplicate names.
const documentRules = config.documentRules ?? [];

// Build supplier-account lookup
const supplierAccountLookup = [];

for (const [supplierDomain, companies] of Object.entries(config.supplierAccounts ?? {})) {
    for (const [companyId, accounts] of Object.entries(companies)) {
        const company = config.companies.find(company => company.id === companyId);

        if (!company) {
            console.warn(`Unknown company ID "${companyId}" in supplierAccounts`);
            continue;
        }

        for (const account of accounts) {
            const accountNumber = normaliseText(account);

            if (!accountNumber) {
                continue;
            }

            supplierAccountLookup.push({
                supplierDomain:
                    supplierDomain.trim().toLowerCase(),

                accountNumber:
                    accountNumber,

                company
            });
        }
    }
}

export default async function matchFileRules(file, { from } = {}) {
    if (!file || !file.content) {
        return {
            status: "failed_to_process",
            file,
            error: "The file has no content to process"
        };
    }

    const senderDomain = getSenderDomain(from);

    try {
        // The caller normally reads the text once for the whole attachment and
        // passes in just this document's pages, so a 22-invoice batch is read
        // and OCR'd once rather than 22 times. Reading it here is the fallback
        // for a caller holding nothing but a file.
        const text = file.text ?? (await readPdfText(file)).text;

        /*
         * 1. Check ignore rules first.
         *
         * Examples:
         * - Statements
         * - Own invoices
         * - Parking notices
         * - Licensing documents
         * - Vehicle documents
         */
        const ignoreRule = findDocumentRule(text, "ignore");

        if (ignoreRule) {
            return {
                status: "ignore",
                file,
                text,
                rule: ignoreRule.rule.name,
                matchCount: ignoreRule.matchCount,
                matchedValues: ignoreRule.matchedValues
            };
        }

        /*
         * 2. Check whether the document looks like
         * a supplier invoice or supplier credit note.
         */
        const routeRule = findDocumentRule(text, "route");

        if (!routeRule) {
            return {
                status: "needs_review",
                file,
                text,
                reason: "Document is not recognised as an invoice or credit note"
            };
        }

        /*
         * 3. Match supplier account number.
         *
         * This is the strongest company match because
         * it combines the sender domain and account number.
         */
        const supplierAccountMatch = findCompanyFromSupplierAccount(file, text, senderDomain);

        if (supplierAccountMatch) {
            return {
                ...supplierAccountMatch,
                documentRule:
                    routeRule.rule.name,
                documentMatchCount:
                    routeRule.matchCount
            };
        }

        /*
         * 4. Match the company name inside the PDF.
         */
        const pdfMatch = findCompanyFromPDFText(file, text);

        if (pdfMatch) {
            return {
                ...pdfMatch,
                documentRule:
                    routeRule.rule.name,
                documentMatchCount:
                    routeRule.matchCount
            };
        }

        /*
         * 5. Fall back to sender-domain routing.
         */
        const senderMatch = findCompanyFromSender(file, senderDomain);

        if (senderMatch) {
            return {
                ...senderMatch,
                documentRule:
                    routeRule.rule.name,
                documentMatchCount:
                    routeRule.matchCount
            };
        }

        /*
         * 6. Invoice identified, but company could
         * not be determined.
         */
        return {
            status: "needs_review",
            file,
            text,
            documentRule:
                routeRule.rule.name,
            documentMatchCount:
                routeRule.matchCount,
            reason: "Invoice or credit note found, but company could not be matched"
        };
    } catch (error) {
        return {
            status: "failed_to_process",
            file,
            error:
                error instanceof Error
                    ? error.message
                    : String(error)
        };
    }
}

function matchesDocumentCheck(text, check) {
    if (!check.text?.trim()) {
        return false;
    }

    switch (check.match) {
        case "contains":
            return normaliseText(text).includes(
                normaliseText(check.text)
            );

        case "whole_word": {
            const documentText =
                ` ${normaliseWords(text)} `;

            const searchText =
                ` ${normaliseWords(check.text)} `;

            return documentText.includes(searchText);
        }

        default:
            return false;
    }
}

/**
 * Find a matching document rule by action.
 *
 * Example actions:
 * - ignore
 * - route
 */
function findDocumentRule(text, action) {
    const normalisedText = normaliseText(text);

    for (const rule of documentRules) {
        if (rule.action !== action) {
            continue;
        }

        const hasRequiredTerm = (rule.requiredTerms ?? []).every((term) => {
            const normalisedTerm = normaliseText(term);
            return normalisedTerm && normalisedText.includes(normalisedTerm);
        });

        if (!hasRequiredTerm) {
            continue;
        }

        let matchCount = 0;
        const matchedValues = [];

        for (const check of rule.rules ?? []) {
            if (matchesDocumentCheck(text, check)) {
                matchCount++;
                matchedValues.push(check.text);
            }

        }

        if (matchCount >= Number(rule.matchThreshold ?? 1)) {
            return {
                rule,
                matchCount,
                matchedValues
            };
        }
    }

    return null;
}

/**
 * Match a company using the sender's domain.
 */
function findCompanyFromSender(file, senderDomain) {

    if (!senderDomain) { return null; }

    for (const [rule, company] of senderLookup) {
        const senderMatches = senderDomain === rule || senderDomain.endsWith("." + rule);

        if (senderMatches) {
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

/**
 * Match a company alias found inside the PDF.
 */
function findCompanyFromPDFText(file, text) {
    // remove email address from the pdf because the output gets confused

    const textWithoutEmail = String(text).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ");

    const normalisedText = normaliseText(textWithoutEmail);

    for (const company of config.companies) {
        for (const alias of company.names ?? []) {
            const normalisedAlias = normaliseText(alias);

            if (!normalisedAlias) {
                continue;
            }

            if (normalisedText.includes(normalisedAlias)) {
                return {
                    status: "matched",
                    file,
                    text,
                    company: company,
                    matchedBy: "pdf_alias",
                    matchedAlias: alias
                };
            }
        }
    }

    return null;
}

/**
 * Match a company using both:
 *
 * 1. Supplier sender domain
 * 2. Account number inside the PDF
 */
function findCompanyFromSupplierAccount(file, text, senderDomain) {
    if (!senderDomain) {
        return null;
    }

    const normalisedText = normaliseText(text);

    for (const supplier of supplierAccountLookup) {
        const senderMatches = senderDomain === supplier.supplierDomain || senderDomain.endsWith("." + supplier.supplierDomain);

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

/**
 * Extract the domain from an email address.
 *
 * Examples:
 * accounts@example.com
 * Supplier Name <accounts@example.com>
 */
function getSenderDomain(senderEmail = "") {
    if (typeof senderEmail !== "string" || !senderEmail.trim()) {
        return null;
    }

    const addressMatch = senderEmail
        .trim()
        .toLowerCase()
        .match(
            /<?([^<>\s@]+@([^<>\s@]+))>?$/
        );

    return (
        addressMatch?.[2]?.replace(/\.$/, "") ??
        null
    );
}

/**
 * Normalise text so variations such as spaces,
 * punctuation and capital letters do not prevent
 * matches.
 */
function normaliseText(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(
            /\blimited\b/g,
            "ltd"
        )
        .replace(
            /[^a-z0-9]/g,
            ""
        );
}


function normaliseWords(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/\blimited\b/g, "ltd")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Count characters that could plausibly be document content:
 * letters and digits only, whitespace and punctuation discarded.
 */
function countUseful(value = "") {
    return String(value)
        .replace(/\s+/g, "")
        .replace(/[^\p{L}\p{N}]/gu, "")
        .length;
}
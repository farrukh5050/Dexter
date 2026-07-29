import fs from "fs/promises";
import { PDFParse } from "pdf-parse";

// Load company aliases and routing rules
const configUrl = new URL(
    "./json_files/company_aliases.json",
    import.meta.url
);

const config = JSON.parse(
    await fs.readFile(configUrl, "utf-8")
);

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

// Build document-rule lookup
const ruleMap = Object.fromEntries(
    (config.documentRules ?? []).map(rule => [
        rule.name,
        rule
    ])
);

// Build supplier-account lookup
const supplierAccountLookup = [];

for (
    const [supplierDomain, companies]
    of Object.entries(config.supplierAccounts ?? {})
) {
    for (
        const [companyId, accounts]
        of Object.entries(companies)
    ) {
        const company = config.companies.find(
            company => company.id === companyId
        );

        if (!company) {
            console.warn(
                `Unknown company ID "${companyId}" in supplierAccounts`
            );

            continue;
        }

        for (const account of accounts) {
            supplierAccountLookup.push({
                supplierDomain:
                    supplierDomain.toLowerCase(),

                accountNumber:
                    normaliseText(account),

                company
            });
        }
    }
}

export default async function fileToRoute(
    file,
    { from } = {}
) {
    if (!file || !file.content) {
        return {
            status: "failed_to_process",
            file,
            error: "The file has no content to process"
        };
    }

    let parser;

    try {
        parser = new PDFParse({
            data: file.content
        });

        const result = await parser.getText();
        const text = result.text ?? "";

        // Scanned PDF with no useful extractable text
        if (!hasUsefulText(text)) {
            return {
                status: "ocr_required",
                file,
                text
            };
        }

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
        const ignoreRule = findDocumentRule(
            text,
            "ignore"
        );

        if (ignoreRule) {
            return {
                status: "ignore",
                file,
                text,
                rule: ignoreRule.rule.name,
                matchCount: ignoreRule.matchCount,
                matchedValues:
                    ignoreRule.matchedValues
            };
        }

        /*
         * 2. Check whether the document looks like
         * a supplier invoice or supplier credit note.
         */
        const routeRule = findDocumentRule(
            text,
            "route"
        );

        if (!routeRule) {
            return {
                status: "needs_review",
                file,
                text,
                reason:
                    "Document is not recognised as an invoice or credit note"
            };
        }

        /*
         * 3. Match supplier account number.
         *
         * This is the strongest company match because
         * it combines the sender domain and account number.
         */
        const supplierAccountMatch =
            findCompanyFromSupplierAccount(
                file,
                text,
                from
            );

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
        const pdfMatch = findCompanyFromPDF(
            file,
            text
        );

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
        const senderMatch = findCompanyFromSender(
            file,
            from
        );

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
            reason:
                "Invoice or credit note found, but company could not be matched"
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
    } finally {
        if (parser) {
            await parser
                .destroy()
                .catch(() => { });
        }
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
    const normalisedText =
        normaliseText(text);

    for (const rule of Object.values(ruleMap)) {
        if (rule.action !== action) {
            continue;
        }

        let matchCount = 0;
        const matchedValues = [];

        for (const check of rule.rules ?? []) {
            if (check.match !== "contains") {
                continue;
            }

            const normalisedCheck =
                normaliseText(check.text);

            if (
                normalisedText.includes(
                    normalisedCheck
                )
            ) {
                matchCount++;
                matchedValues.push(check.text);
            }
        }

        if (
            matchCount >=
            Number(rule.matchThreshold ?? 1)
        ) {
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
function findCompanyFromSender(
    file,
    senderEmail = ""
) {
    const senderDomain =
        getSenderDomain(senderEmail);

    if (!senderDomain) {
        return null;
    }

    for (const [rule, company] of senderLookup) {
        const senderMatches =
            senderDomain === rule ||
            senderDomain.endsWith(
                "." + rule
            );

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
function findCompanyFromPDF(file, text) {
    const normalisedText =
        normaliseText(text);

    const match =
        findCompanyFromText(normalisedText);

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

/**
 * Search all configured company aliases.
 */
function findCompanyFromText(text) {
    for (const company of config.companies) {
        for (const alias of company.names ?? []) {
            const normalisedAlias =
                normaliseText(alias);

            if (
                text.includes(normalisedAlias)
            ) {
                return {
                    company,
                    alias
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
function findCompanyFromSupplierAccount(
    file,
    text,
    senderEmail = ""
) {
    const senderDomain =
        getSenderDomain(senderEmail);

    if (!senderDomain) {
        return null;
    }

    const normalisedText =
        normaliseText(text);

    for (
        const supplier
        of supplierAccountLookup
    ) {
        const senderMatches =
            senderDomain ===
            supplier.supplierDomain ||
            senderDomain.endsWith(
                "." + supplier.supplierDomain
            );

        if (!senderMatches) {
            continue;
        }

        if (
            normalisedText.includes(
                supplier.accountNumber
            )
        ) {
            return {
                status: "matched",
                file,
                company: supplier.company,
                matchedBy:
                    "supplier_account",
                matchedValue:
                    supplier.accountNumber
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
    if (
        typeof senderEmail !== "string" ||
        !senderEmail.trim()
    ) {
        return null;
    }

    const addressMatch = senderEmail
        .trim()
        .toLowerCase()
        .match(
            /<?([^<>\s@]+@([^<>\s@]+))>?$/
        );

    return (
        addressMatch?.[2]
            ?.replace(/\.$/, "") ??
        null
    );
}

/**
 * Determine whether the PDF contains enough
 * extractable text to process without OCR.
 */
function hasUsefulText(text) {
    const cleaned = String(text ?? "")
        .replace(/\s+/g, "")
        .replace(
            /[^\p{L}\p{N}]/gu,
            ""
        );

    return cleaned.length >= 30;
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
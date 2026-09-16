/*
 * Decide what an attachment actually holds before anything tries to route it.
 *
 * Three different things arrive as multi-page PDFs and only one of them wants
 * splitting:
 *
 *   report - a 60-page operational report. Discard whole. Splitting it would
 *            produce 60 pieces of garbage.
 *   chase  - "MAY INVOICES OUTSTANDING", "copy invoices". These are invoices
 *            already posted, sent to chase payment. Posting them again creates
 *            duplicate bills, so they never auto-post.
 *   batch  - one supplier, a month of real invoices, one PDF. Split this.
 *
 * Everything here is a pure function of the page text and the filename, so it
 * can be tested from a fixture with no PDF and no mailbox.
 */

const DEFAULT_MIN_PAGES = 3;

const DEFAULT_SPLIT = {
    pageMarkerPattern: "page\\s+(\\d+)\\s+of\\s+(\\d+)",
    invoiceNumberPatterns: [
        "invoice\\s*(?:number|no\\.?|#)\\s*[:\\-]?\\s*([A-Z0-9][A-Z0-9\\-\\/]{2,19})",
        "inv\\s*(?:no\\.?|#)\\s*[:\\-]?\\s*([A-Z0-9][A-Z0-9\\-\\/]{2,19})"
    ],
    totalsTerms: ["total due", "amount due", "balance due", "total payable", "invoice total"],
    // Many invoices just say "Total £130.00". A bare "total" would also match
    // a column header, so require a money amount next to it.
    totalsPatterns: ["total\\s*[£$€]?\\s*[\\d,]+\\.\\d{2}"]
};

function normalise(value = "") {
    return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text, terms = []) {
    const haystack = normalise(text);

    return terms.some(term => {
        const needle = normalise(term);
        return needle.length > 0 && haystack.includes(needle);
    });
}

function matchesAny(text, patterns = []) {
    return patterns.some(pattern => new RegExp(pattern, "i").test(text));
}

/** A page ends a document when it carries a totals block. */
function hasTotals(text, settings) {
    return containsAny(text, settings.totalsTerms)
        || matchesAny(text, settings.totalsPatterns);
}

/** Read a "Page 1 of 3" style marker, if the page carries one. */
function readPageMarker(text, pattern) {
    if (!pattern) {
        return null;
    }

    const match = normalise(text).match(new RegExp(pattern, "i"));

    if (!match) {
        return null;
    }

    return {
        page: Number(match[1]),
        of: Number(match[2])
    };
}

/** Read the first invoice number the page shows, if any. */
function readInvoiceNumber(text, patterns = []) {
    for (const pattern of patterns) {
        const match = text.match(new RegExp(pattern, "i"));

        if (match?.[1]) {
            return match[1].toUpperCase().trim();
        }
    }

    return null;
}

/**
 * Group pages into documents on boundary signals, strongest first:
 *
 *   1. an explicit "page 1 of N" marker always starts a document
 *   2. an invoice number that differs from the current document's starts one
 *   3. an invoice number on the page after a totals block starts one
 *
 * Anything else is a continuation of the document in progress.
 */
export function splitIntoDocuments(pages, spec = {}) {
    const settings = { ...DEFAULT_SPLIT, ...spec };

    const marks = pages.map(page => ({
        num: page.num,
        marker: readPageMarker(page.text, settings.pageMarkerPattern),
        invoiceNo: readInvoiceNumber(page.text, settings.invoiceNumberPatterns),
        hasTotals: hasTotals(page.text, settings)
    }));

    const groups = [];

    for (const [index, mark] of marks.entries()) {
        const current = groups.at(-1);
        const previous = marks[index - 1];

        const startsNewDocument =
            !current
            || mark.marker?.page === 1
            || (mark.invoiceNo && current.invoiceNo && mark.invoiceNo !== current.invoiceNo)
            || (previous?.hasTotals && Boolean(mark.invoiceNo));

        if (startsNewDocument) {
            groups.push({
                pages: [mark.num],
                invoiceNo: mark.invoiceNo,
                hasTotals: mark.hasTotals
            });

            continue;
        }

        current.pages.push(mark.num);
        current.invoiceNo = current.invoiceNo ?? mark.invoiceNo;
        current.hasTotals = current.hasTotals || mark.hasTotals;
    }

    return { groups, marks };
}

/**
 * A split is only safe when the whole container resolves cleanly: every group
 * identifiable by its own invoice number, and every group ending in a totals
 * block. Anything less and the container goes to review whole - half an
 * invoice posted as a bill is far worse than a human opening a PDF.
 */
export function assessSplit(groups) {
    const named = groups.filter(group => group.invoiceNo).length;
    const withTotals = groups.filter(group => group.hasTotals).length;

    return {
        count: groups.length,
        named,
        withTotals,
        clean:
            groups.length > 1
            && named === groups.length
            && withTotals === groups.length
    };
}

/**
 * Work out what to do with a container.
 *
 * Returns one of:
 *   { kind: "report", action: "ignore" }
 *   { kind: "chase",  action: "review" }
 *   { kind: "single", action: "process", groups: [[1, 2]] }
 *   { kind: "batch",  action: "split",   groups: [[1], [2, 3], …] }
 *   { kind: "batch",  action: "review" }            boundaries unresolved
 */
export default function triageContainer({ pages = [], filename = "" }, rules = {}) {
    const allPages = pages.map(page => page.num);
    const fullText = pages.map(page => page.text).join("\n\n");

    for (const rule of rules.reports ?? []) {
        if (matchesContainerRule(rule, fullText, filename)) {
            return {
                kind: "report",
                action: "ignore",
                reason: `matched report rule "${rule.name}"`,
                groups: []
            };
        }
    }

    for (const rule of rules.chases ?? []) {
        if (matchesContainerRule(rule, fullText, filename)) {
            return {
                kind: "chase",
                action: "review",
                reason: `matched chase rule "${rule.name}" - may already be posted`,
                groups: [allPages]
            };
        }
    }

    const minPages = rules.split?.minPages ?? DEFAULT_MIN_PAGES;

    if (pages.length < minPages) {
        return {
            kind: "single",
            action: "process",
            reason: `${pages.length} page(s), below the ${minPages}-page batch threshold`,
            groups: [allPages]
        };
    }

    const { groups } = splitIntoDocuments(pages, rules.split);
    const quality = assessSplit(groups);

    if (quality.clean) {
        return {
            kind: "batch",
            action: "split",
            reason:
                `${quality.count} documents across ${pages.length} pages, ` +
                `all with an invoice number and a totals block`,
            groups: groups.map(group => group.pages)
        };
    }

    if (quality.count > 1) {
        return {
            kind: "batch",
            action: "review",
            reason:
                `looks like ${quality.count} documents across ${pages.length} pages, ` +
                `but only ${quality.named} have an invoice number and ` +
                `${quality.withTotals} have a totals block - not splitting`,
            groups: [allPages]
        };
    }

    return {
        kind: "single",
        action: "process",
        reason: `${pages.length} pages, no document boundaries found`,
        groups: [allPages]
    };
}

function matchesContainerRule(rule, text, filename) {
    const haystack = rule.matchOn === "filename" ? filename : text;

    if (rule.require && !containsAny(haystack, rule.require)) {
        return false;
    }

    if (!rule.anyOf) {
        return Boolean(rule.require);
    }

    const hits = rule.anyOf.filter(term => containsAny(haystack, [term])).length;

    return hits >= Number(rule.threshold ?? 1);
}

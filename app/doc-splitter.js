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

/** Read the page number from a "Page 1 of 3" style marker, if there is one. */
function readPageNumber(text, pattern) {
    const match = pattern && normalise(text).match(new RegExp(pattern, "i"));

    return match ? Number(match[1]) : null;
}

/**
 * Read the first invoice number the page shows, if any.
 *
 * The patterns are written in upper case but have to run case-insensitively,
 * because a real invoice says "INVOICE NO" as often as "Invoice no". That lets
 * the capture swallow ordinary words - "Invoice No: not supplied" would yield
 * "NOT" - so an invoice number has to carry at least one digit.
 */
function readInvoiceNumber(text, patterns = []) {
    for (const pattern of patterns) {
        const match = text.match(new RegExp(pattern, "i"));

        if (match?.[1] && /\d/.test(match[1])) {
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
function splitIntoDocuments(pages, settings) {
    const marks = pages.map(page => ({
        num: page.num,
        pageNumber: readPageNumber(page.text, settings.pageMarkerPattern),
        invoiceNo: readInvoiceNumber(page.text, settings.invoiceNumberPatterns),
        // A page ends a document when it carries a totals block.
        hasTotals: matchesAny(page.text, settings.totalsPatterns)
    }));

    const groups = [];

    for (const [index, mark] of marks.entries()) {
        const current = groups.at(-1);
        const previous = marks[index - 1];

        const startsNewDocument =
            !current
            || mark.pageNumber === 1
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

        // The last page wins, not any page: the test is whether the document
        // ENDS on a totals block. A group that totals on page 1 and then picks
        // up trailing pages has a boundary in the wrong place.
        current.hasTotals = mark.hasTotals;
    }

    return groups;
}

/**
 * A split is only safe when the whole container resolves cleanly: every group
 * identifiable by its own invoice number, and every group ending in a totals
 * block. Anything less and the container goes to review whole - half an
 * invoice posted as a bill is far worse than a human opening a PDF.
 */
function assessSplit(groups) {
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

    // The patterns live in company_aliases.json. A copy of them here would be
    // the one that rots, so there is no fallback: a missing block is a broken
    // install, not a reason to guess.
    if (!rules.split) {
        throw new Error("containerRules.split is missing from company_aliases.json");
    }

    const minPages = rules.split.minPages;

    if (pages.length < minPages) {
        return {
            kind: "single",
            action: "process",
            reason: `${pages.length} page(s), below the ${minPages}-page batch threshold`,
            groups: [allPages]
        };
    }

    const groups = splitIntoDocuments(pages, rules.split);
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

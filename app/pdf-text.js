import { PDFParse } from "pdf-parse";
import extractPdfTextWithOcr from "./pdf-ocr.js";

const OCR_MIN_CHARS = 30;

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

/** The text of the given page numbers, in order, as one string. */
export function pagesText(container, pageNumbers) {
    return pageNumbers
        .map(num => container.pages.find(page => page.num === num)?.text ?? "")
        .join("\n\n");
}

/**
 * Read a PDF's text one page at a time.
 *
 * Embedded text is used wherever a page has it; only the pages that come back
 * effectively empty are sent to OCR. Measuring per page matters: a text cover
 * sheet in front of forty scanned pages would otherwise suppress OCR for all
 * of them, and pdfResult.text joins pages with "-- N of M --" separators that
 * count as content and hide a pure scan entirely.
 */
export default async function readPdfText(file) {
    if (!file?.content) {
        throw new Error("The file has no content to read.");
    }

    const label = file.filename ?? "attachment";
    const parser = new PDFParse({ data: file.content });

    let pages;
    let total;

    try {
        const result = await parser.getText();

        total = result.total;
        pages = result.pages.map(page => ({
            num: page.num,
            text: page.text ?? "",
            textSource: "pdf"
        }));
    } finally {
        await parser.destroy().catch(() => { });
    }

    const emptyPages = pages
        .filter(page => countUseful(page.text) < OCR_MIN_CHARS)
        .map(page => page.num);

    // OCR is per page now, so one blank separator page in a 22-invoice batch
    // is enough to call it. A failure there must not throw away the embedded
    // text the other pages already gave us.
    if (emptyPages.length > 0) {
        try {
            const ocr = await extractPdfTextWithOcr(file, { pages: emptyPages });

            for (const ocrPage of ocr.pages) {
                const page = pages.find(candidate => candidate.num === ocrPage.pageNumber);

                if (!page) {
                    continue;
                }

                page.text = ocrPage.text ?? "";
                page.textSource = "ocr";
                page.ocrConfidence = ocrPage.confidence;
            }

            console.log(
                `${label}: OCR on ${ocr.pages.length}/${total} pages, ` +
                `confidence ${ocr.confidence.toFixed(1)}`
            );
        } catch (error) {
            console.warn(
                `${label}: OCR failed on pages [${emptyPages.join(",")}], ` +
                `keeping embedded text: ${error.message}`
            );
        }
    }

    const usefulChars = pages.reduce(
        (running, page) => running + countUseful(page.text),
        0
    );

    const sources = new Set(pages.map(page => page.textSource));

    const textSource = usefulChars === 0
        ? "none"
        : sources.size > 1 ? "mixed" : (pages[0]?.textSource ?? "none");

    // Log the numbers the OCR branch was decided on, not just the outcome.
    // A count that is small relative to the page count is the tell that
    // something upstream is wrong.
    if (textSource === "none" || usefulChars < OCR_MIN_CHARS * total) {
        console.warn(
            `${label}: only ${usefulChars} useful chars across ${total} pages ` +
            `(source=${textSource})`
        );
    }

    return {
        total,
        pages,
        text: pages.map(page => page.text).join("\n\n"),
        textSource,
        usefulChars
    };
}

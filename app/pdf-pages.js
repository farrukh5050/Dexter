import { PDFDocument } from "pdf-lib";

/**
 * Build a new PDF containing only the given pages, in the given order.
 *
 * Needed because Xero wants one file per bill: a document found on pages 4-5
 * of a 22-page batch has to arrive as its own two-page PDF.
 *
 * Page numbers are 1-based, matching pdf-parse.
 */
export default async function extractPdfPages(content, pageNumbers) {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
        throw new Error("No pages requested.");
    }

    const source = await PDFDocument.load(content, { ignoreEncryption: true });
    const pageCount = source.getPageCount();

    const indices = pageNumbers.map(num => {
        const index = num - 1;

        if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
            throw new Error(
                `Page ${num} is out of range for a ${pageCount}-page document.`
            );
        }

        return index;
    });

    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, indices);

    for (const page of copied) {
        target.addPage(page);
    }

    return Buffer.from(await target.save());
}

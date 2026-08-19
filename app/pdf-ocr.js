import fs from "fs/promises";
import { fileURLToPath } from "url";
import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";


const cachePath = new URL("../attachments/.ocr-cache", import.meta.url);

// Render PDF pages to image buffer
async function renderPdfPages(content) {
    const parser = new PDFParse({ data: content })

    try {
        const result = await parser.getScreenshot({
            scale: 2.5,
            imageDataUrl: false,
            imageBuffer: true
        });

        return result.pages;
    } finally {
        await parser.destroy();
    }
}

// Recognise text from pages and return an array of results
async function recognisePages(worker, pages) {
    const results = [];

    for (const page of pages) {
        const result = await worker.recognize(Buffer.from(page.data));
        results.push({
            pageNumber: page.pageNumber,
            text: result.data.text ?? "",
            confidence: result.data.confidence ?? 0
        });
    }

    return results;
}

// Build an ocr result from the pages
function buildOcrResult(pages) {
    const totalConfidence = pages.reduce(
        (total, page) => total + page.confidence,
        0
    );

    return {
        text: pages.map(page => page.text).join("\n\n"),
        confidence: pages.length > 0 ? totalConfidence / pages.length : 0
    };
}


export default async function extractPdfTextWithOcr(file) {
    if (!file?.content) {
        throw new Error("The file has no content to OCR.");
    }

    await fs.mkdir(cachePath, { recursive: true }); // cachePath is a path to a directory where the worker will store its cache
    // Create a tesseract worker instance
    const worker = await createWorker("eng", 1, {
        cachePath: fileURLToPath(cachePath)
    });

    const renderPages = await renderPdfPages(file.content);

    try {
        const recognisedPages = await recognisePages(worker, renderPages);

        const totalConfidence = recognisedPages.reduce((total, page) => total + page.confidence, 0);

        return {
            text: recognisedPages.map(page => page.text).join("\n\n"),
            confidence: recognisedPages.length > 0 ? totalConfidence / recognisedPages.length : 0
        };

    } finally {
        await worker.terminate()
    }
}

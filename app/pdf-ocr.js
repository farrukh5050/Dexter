import fs from "fs/promises";
import { fileURLToPath } from "url";
import { createWorker } from "tesseract.js";
import { Worker } from "worker_threads";


const cachePath = new URL("../attachments/.ocr-cache", import.meta.url);

// One tesseract worker for the whole process. Spawning tesseract and loading
// the language model per attachment is what made each email cost seconds.
let workerPromise = null;
let ocrQueue = Promise.resolve();

// Lazily create the shared OCR worker, or return the existing one.
function getWorker() {
    if (!workerPromise) {
        workerPromise = (async () => {
            await fs.mkdir(cachePath, { recursive: true });
            return createWorker("eng", 1, { cachePath: fileURLToPath(cachePath) });
        })().catch(error => {
            workerPromise = null; // let the next worker to try to create it again
            throw error;
        });
    }

    return workerPromise;
}

export async function terminateOcrWorker() {
    if (!workerPromise) {
        return;
    }

    const pending = workerPromise;
    workerPromise = null;

    try {
        const worker = await pending;
        await worker.terminate();
    } catch {
        // Nothing to do if the worker has already been terminated
    }
}

const renderWorkerPath = new URL("./pdf-render-worker.js", import.meta.url);

// Render PDF pages to image buffers off the main thread, so rasterising does
// not block the event loop and starve the IMAP connection.
function renderPdfPages(content, { scale = 2.5, pages = null } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(renderWorkerPath, { workerData: { content, scale, pages } });

        let settled = false;

        const finish = (settle, value) => {
            if (settled) {
                return;
            }

            settled = true;
            void worker.terminate();
            settle(value);
        };

        worker.on("message", message => {
            if (message.ok) {
                finish(resolve, message.pages);
            } else {
                finish(reject, new Error(message.error));
            }
        });

        worker.on("error", error => finish(reject, error));

        worker.on("exit", code => {
            if (code !== 0) {
                finish(reject, new Error(`PDF render worker exited with code ${code}`));
            }
        });
    });
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
    const totalConfidence = pages.reduce((total, page) => total + page.confidence, 0);

    return {
        // Per-page results, so a caller that only asked for some pages can
        // merge them back against the pages that already had embedded text.
        pages,
        confidence: pages.length > 0 ? totalConfidence / pages.length : 0
    };
}


export default async function extractPdfTextWithOcr(file, { pages = null } = {}) {
    if (!file.content) {
        throw new Error("The file has no content to OCR")
    }

    // A shared worker handles one job at a time, so keep calls serialised
    const run = ocrQueue.then(async () => {
        const worker = await getWorker();
        const rendered = await renderPdfPages(file.content, { pages });

        return buildOcrResult(await recognisePages(worker, rendered));
    });

    ocrQueue = run.catch(() => { });

    return run;
}
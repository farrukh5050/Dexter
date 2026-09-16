import { parentPort, workerData } from "worker_threads";
import { PDFParse } from "pdf-parse";

const parser = new PDFParse({ data: workerData.content });

try {
    const result = await parser.getScreenshot({
        scale: workerData.scale,
        imageDataUrl: false,
        imageBuffer: true,
        // Rasterising is the slow half, so only render the pages asked for.
        ...(workerData.pages?.length ? { partial: workerData.pages } : {})
    });

    parentPort.postMessage({
        ok: true,
        pages: result.pages.map(page => ({
            pageNumber: page.pageNumber,
            data: page.data
        }))
    });
} catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
} finally {
    await parser.destroy();
}
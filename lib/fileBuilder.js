// lib/fileBuilders.js
//
// Turns AI-drafted structured content (see commands/ai.js's DRAFT_SCHEMAS)
// into real files on disk. No AI involved here — pure formatting, same
// separation-of-concerns .teach uses (extraction vs. summarization).
//
// Every build* function writes to a temp file and returns its path —
// callers must clean it up after sending (same pattern as play.js's
// cleanupTempFile for audio files).

const fs = require("fs");
const os = require("os");
const path = require("path");

function tempFilePath(ext) {
    return path.join(os.tmpdir(), `zorex-ai-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

/**
 * @param {{ title: string, sections: Array<{ heading: string, body: string }> }} draft
 * @param {Array<{ buffer: Buffer, mimeType: string }>} images
 * @returns {Promise<string>} file path
 */
async function buildDocx(draft, images = []) {

    const { Document, Packer, Paragraph, HeadingLevel, ImageRun } = require("docx");

    const children = [
        new Paragraph({ text: draft.title || "Document", heading: HeadingLevel.TITLE })
    ];

    for (const section of draft.sections || []) {
        if (section.heading) children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
        if (section.body) children.push(new Paragraph({ text: section.body }));
    }

    for (const img of images.slice(0, 5)) {
        try {
            children.push(new Paragraph({
                children: [new ImageRun({ data: img.buffer, transformation: { width: 400, height: 300 } })]
            }));
        } catch (err) {
            console.error("[fileBuilders] skipped an image in docx build:", err.message);
        }
    }

    const doc = new Document({ sections: [{ children }] });
    const filePath = tempFilePath("docx");
    fs.writeFileSync(filePath, await Packer.toBuffer(doc));

    return filePath;

}

/**
 * @param {{ sheets: Array<{ name: string, headers: string[], rows: any[][] }> }} draft
 * @returns {Promise<string>} file path
 */
async function buildXlsx(draft) {

    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();

    const sheets = (draft.sheets && draft.sheets.length > 0) ? draft.sheets : [{ name: "Sheet1", headers: [], rows: [] }];

    for (const sheetDef of sheets) {

        const sheet = workbook.addWorksheet(sheetDef.name || "Sheet1");

        if (sheetDef.headers && sheetDef.headers.length > 0) {
            sheet.addRow(sheetDef.headers);
            sheet.getRow(1).font = { bold: true };
        }

        for (const row of sheetDef.rows || []) sheet.addRow(row);

        sheet.columns.forEach((col) => { col.width = 20; });

    }

    const filePath = tempFilePath("xlsx");
    await workbook.xlsx.writeFile(filePath);

    return filePath;

}

/**
 * @param {{ title: string, slides: Array<{ title: string, bullets: string[] }> }} draft
 * @param {Array<{ buffer: Buffer, mimeType: string }>} images
 * @returns {Promise<string>} file path
 */
async function buildPptx(draft, images = []) {

    const PptxGenJS = require("pptxgenjs");
    const pres = new PptxGenJS();

    const titleSlide = pres.addSlide();
    titleSlide.addText(draft.title || "Presentation", { x: 0.5, y: 2, w: "90%", h: 1.5, fontSize: 32, bold: true, align: "center" });

    for (const slideDef of draft.slides || []) {

        const slide = pres.addSlide();
        slide.addText(slideDef.title || "", { x: 0.5, y: 0.3, w: "90%", h: 1, fontSize: 24, bold: true });

        const bulletText = (slideDef.bullets || []).map((b) => ({ text: b, options: { bullet: true, breakLine: true } }));
        if (bulletText.length > 0) slide.addText(bulletText, { x: 0.5, y: 1.3, w: "90%", h: 4, fontSize: 16 });

    }

    // Source images get their own trailing slide(s) — the draft JSON has
    // no way to know which image belongs on which bullet slide.
    for (const img of images.slice(0, 5)) {
        try {
            const slide = pres.addSlide();
            slide.addImage({ data: `data:${img.mimeType};base64,${img.buffer.toString("base64")}`, x: 0.5, y: 0.5, w: 9, h: 5 });
        } catch (err) {
            console.error("[fileBuilders] skipped an image in pptx build:", err.message);
        }
    }

    const filePath = tempFilePath("pptx");
    await pres.writeFile({ fileName: filePath });

    return filePath;

}

/**
 * @param {{ title: string, sections: Array<{ heading: string, body: string }> }} draft
 * @param {Array<{ buffer: Buffer, mimeType: string }>} images
 * @returns {Promise<string>} file path
 */
async function buildPdf(draft, images = []) {

    const PDFDocument = require("pdfkit");
    const filePath = tempFilePath("pdf");

    await new Promise((resolve, reject) => {

        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        doc.fontSize(22).text(draft.title || "Document", { align: "center" });
        doc.moveDown();

        for (const section of draft.sections || []) {
            if (section.heading) { doc.fontSize(16).text(section.heading, { underline: true }); doc.moveDown(0.5); }
            if (section.body) { doc.fontSize(12).text(section.body); doc.moveDown(); }
        }

        for (const img of images.slice(0, 5)) {
            try {
                doc.addPage();
                doc.image(img.buffer, { fit: [480, 600], align: "center" });
            } catch (err) {
                console.error("[fileBuilders] skipped an image in pdf build:", err.message);
            }
        }

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);

    });

    return filePath;

}

module.exports = { buildDocx, buildXlsx, buildPptx, buildPdf };
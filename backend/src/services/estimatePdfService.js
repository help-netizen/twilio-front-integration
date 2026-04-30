/**
 * Lightweight PDF renderer for client-facing estimates.
 *
 * Uses built-in PDF standard fonts so the backend does not need a binary
 * rendering dependency for the first PDF implementation.
 */

const COMPANY_PROFILE = {
    name: 'ABC Homes',
    address: '2502 Village Rd W, Norwood, MA 02062, USA',
    email: 'help@bostonmasters.com',
    phone: '(508) 290-4442',
    ach: {
        bank: 'Bank Of America',
        routingNumber: '011000138',
        accountNumber: '466020155621',
    },
};

const DEFAULT_TERMS_AND_WARRANTY = `TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.

WARRANTY:
- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.
- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer's standard warranty is shorter.
- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.
- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.`;

const PAGE = { width: 612, height: 792, margin: 44 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
        .replace(/\r\n?/g, '\n');
}

function escapePdfText(value) {
    return normalizeText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function money(value) {
    return '$' + Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatDate(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function itemMeta(item) {
    const qty = Number(item.quantity || 1);
    const unitPrice = money(item.unit_price);
    return qty === 1 ? unitPrice : `${qty} x ${unitPrice}`;
}

function textWidth(value, size) {
    return normalizeText(value).length * size * 0.52;
}

function wrapParagraph(text, size, maxWidth) {
    const paragraphs = normalizeText(text).split('\n');
    const lines = [];
    for (const paragraph of paragraphs) {
        const words = paragraph.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) {
            lines.push('');
            continue;
        }
        let line = '';
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (textWidth(candidate, size) <= maxWidth || !line) {
                line = candidate;
            } else {
                lines.push(line);
                line = word;
            }
        }
        if (line) lines.push(line);
    }
    return lines;
}

class PdfCanvas {
    constructor() {
        this.pages = [[]];
        this.y = PAGE.margin;
    }

    get ops() {
        return this.pages[this.pages.length - 1];
    }

    pdfY(topY) {
        return PAGE.height - topY;
    }

    ensure(height) {
        if (this.y + height <= PAGE.height - PAGE.margin) return;
        this.pages.push([]);
        this.y = PAGE.margin;
    }

    setColor(gray = 0) {
        this.ops.push(`${gray} ${gray} ${gray} rg`);
    }

    text(value, x, y, { size = 10, font = 'F1', gray = 0 } = {}) {
        this.ops.push(`BT /${font} ${size} Tf ${gray} ${gray} ${gray} rg ${x.toFixed(2)} ${this.pdfY(y).toFixed(2)} Td (${escapePdfText(value)}) Tj ET`);
    }

    rightText(value, rightX, y, options = {}) {
        const size = options.size || 10;
        this.text(value, rightX - textWidth(value, size), y, options);
    }

    line(x1, y1, x2, y2, gray = 0.82) {
        this.ops.push(`${gray} ${gray} ${gray} RG ${x1.toFixed(2)} ${this.pdfY(y1).toFixed(2)} m ${x2.toFixed(2)} ${this.pdfY(y2).toFixed(2)} l S`);
    }

    rect(x, y, width, height, gray = 0.96) {
        this.ops.push(`${gray} ${gray} ${gray} rg ${x.toFixed(2)} ${(this.pdfY(y) - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
    }

    paragraph(text, x, y, width, { size = 10, lineHeight = 14, font = 'F1', gray = 0 } = {}) {
        const lines = wrapParagraph(text, size, width);
        let cursor = y;
        for (const line of lines) {
            this.ensure(lineHeight + 4);
            if (line) this.text(line, x, cursor, { size, font, gray });
            cursor += lineHeight;
        }
        return cursor;
    }

    heading(label) {
        this.ensure(34);
        this.text(label.toUpperCase(), PAGE.margin, this.y, { size: 9, font: 'F2', gray: 0.42 });
        this.y += 14;
        this.line(PAGE.margin, this.y, PAGE.width - PAGE.margin, this.y, 0.88);
        this.y += 14;
    }

    footer(pageIndex) {
        const pageNumber = pageIndex + 1;
        this.pages[pageIndex].push(`BT /F1 8 Tf 0.55 0.55 0.55 rg ${(PAGE.width - PAGE.margin - 38).toFixed(2)} ${(PAGE.height - (PAGE.height - 28)).toFixed(2)} Td (Page ${pageNumber}) Tj ET`);
    }

    finish() {
        this.pages.forEach((_, idx) => this.footer(idx));
    }
}

function renderHeader(pdf, estimate) {
    const left = PAGE.margin;
    const right = PAGE.width - PAGE.margin;

    pdf.text(COMPANY_PROFILE.name, left, pdf.y, { size: 18, font: 'F2' });
    pdf.text(COMPANY_PROFILE.address, left, pdf.y + 18, { size: 9, gray: 0.35 });
    pdf.text(`${COMPANY_PROFILE.email}  |  ${COMPANY_PROFILE.phone}`, left, pdf.y + 32, { size: 9, gray: 0.35 });

    pdf.rightText(estimate.estimate_number || 'ESTIMATE', right, pdf.y, { size: 16, font: 'F2' });
    pdf.rightText(`Date: ${formatDate(estimate.updated_at || estimate.created_at)}`, right, pdf.y + 20, { size: 9, gray: 0.35 });
    pdf.rightText(`Status: ${estimate.status || 'draft'}`, right, pdf.y + 34, { size: 9, gray: 0.35 });
    pdf.y += 58;
    pdf.line(left, pdf.y, right, pdf.y);
    pdf.y += 22;
}

function renderPreparedFor(pdf, estimate) {
    const left = PAGE.margin;
    const boxWidth = CONTENT_WIDTH / 2 - 8;
    const rightBoxX = left + boxWidth + 16;
    pdf.rect(left, pdf.y - 6, CONTENT_WIDTH, 76, 0.965);
    pdf.text('PREPARED FOR', left + 12, pdf.y + 8, { size: 8, font: 'F2', gray: 0.45 });
    pdf.text(estimate.contact_name || 'Customer', left + 12, pdf.y + 24, { size: 12, font: 'F2' });
    if (estimate.contact_email) pdf.text(estimate.contact_email, left + 12, pdf.y + 40, { size: 9, gray: 0.35 });
    if (estimate.contact_phone) pdf.text(estimate.contact_phone, left + 12, pdf.y + 54, { size: 9, gray: 0.35 });

    pdf.text('JOB', rightBoxX, pdf.y + 8, { size: 8, font: 'F2', gray: 0.45 });
    pdf.text(estimate.job_number ? `#${estimate.job_number}` : 'Not linked', rightBoxX, pdf.y + 24, { size: 11, font: 'F2' });
    pdf.text(`Estimate total: ${money(estimate.total)}`, rightBoxX, pdf.y + 44, { size: 13, font: 'F2' });
    pdf.y += 92;
}

function renderSummary(pdf, estimate) {
    if (!estimate.summary) return;
    pdf.heading('Summary');
    pdf.y = pdf.paragraph(estimate.summary, PAGE.margin, pdf.y, CONTENT_WIDTH, { size: 10, lineHeight: 15, gray: 0.08 }) + 10;
}

function renderItems(pdf, estimate) {
    pdf.heading('Items');
    const amountX = PAGE.width - PAGE.margin;
    for (const item of estimate.items || []) {
        const descLines = item.description ? wrapParagraph(item.description, 9, 350) : [];
        const rowHeight = 38 + descLines.length * 12;
        pdf.ensure(rowHeight + 8);
        pdf.text(item.name || 'Item', PAGE.margin, pdf.y, { size: 11, font: 'F2' });
        pdf.rightText(money(item.amount), amountX, pdf.y, { size: 11, font: 'F2' });
        pdf.text(itemMeta(item), PAGE.margin, pdf.y + 15, { size: 9, gray: 0.45 });
        let descY = pdf.y + 29;
        for (const line of descLines) {
            pdf.text(line, PAGE.margin, descY, { size: 9, gray: 0.35 });
            descY += 12;
        }
        pdf.y += rowHeight;
        pdf.line(PAGE.margin, pdf.y - 8, PAGE.width - PAGE.margin, pdf.y - 8, 0.9);
    }
    pdf.y += 8;
}

function renderTotals(pdf, estimate) {
    const labelX = PAGE.width - PAGE.margin - 190;
    const valueX = PAGE.width - PAGE.margin;
    const rows = [
        ['Subtotal', money(estimate.subtotal)],
    ];
    if (Number(estimate.discount_amount || 0) > 0) rows.push(['Discount', `-${money(estimate.discount_amount)}`]);
    if (Number(estimate.tax_amount || 0) > 0) rows.push(['Tax', money(estimate.tax_amount)]);

    pdf.ensure(86);
    for (const [label, value] of rows) {
        pdf.text(label, labelX, pdf.y, { size: 10, gray: 0.35 });
        pdf.rightText(value, valueX, pdf.y, { size: 10 });
        pdf.y += 17;
    }
    pdf.line(labelX, pdf.y, valueX, pdf.y, 0.82);
    pdf.y += 18;
    pdf.text('Total', labelX, pdf.y, { size: 12, font: 'F2' });
    pdf.rightText(money(estimate.total), valueX, pdf.y, { size: 12, font: 'F2' });
    pdf.y += 32;
}

function renderTerms(pdf) {
    pdf.heading('Terms & Warranty');
    pdf.y = pdf.paragraph(DEFAULT_TERMS_AND_WARRANTY, PAGE.margin, pdf.y, CONTENT_WIDTH, { size: 8.5, lineHeight: 12, gray: 0.2 }) + 10;
}

function renderAch(pdf) {
    pdf.heading('ACH Payments');
    const lines = [
        `For ACH Payments: ${COMPANY_PROFILE.ach.bank}`,
        `Routing Number: ${COMPANY_PROFILE.ach.routingNumber}`,
        `Account Number: ${COMPANY_PROFILE.ach.accountNumber}`,
    ];
    for (const line of lines) {
        pdf.ensure(16);
        pdf.text(line, PAGE.margin, pdf.y, { size: 9.5, font: line.startsWith('For ACH') ? 'F2' : 'F1' });
        pdf.y += 15;
    }
}

function buildPdfBuffer(pageStreams) {
    const objects = [];
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

    const kids = [];
    pageStreams.forEach((stream, index) => {
        const pageObjId = 5 + index * 2;
        const contentObjId = pageObjId + 1;
        kids.push(`${pageObjId} 0 R`);
        objects[pageObjId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjId} 0 R >>`;
        const length = Buffer.byteLength(stream, 'utf8');
        objects[contentObjId] = `<< /Length ${length} >>\nstream\n${stream}\nendstream`;
    });
    objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageStreams.length} >>`;

    let body = '%PDF-1.4\n';
    const offsets = [0];
    for (let id = 1; id < objects.length; id++) {
        offsets[id] = Buffer.byteLength(body, 'utf8');
        body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(body, 'utf8');
    body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) {
        body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(body, 'utf8');
}

function renderEstimatePdf(estimate) {
    const pdf = new PdfCanvas();
    renderHeader(pdf, estimate);
    renderPreparedFor(pdf, estimate);
    renderSummary(pdf, estimate);
    renderItems(pdf, estimate);
    renderTotals(pdf, estimate);
    renderTerms(pdf);
    renderAch(pdf);
    pdf.finish();

    return buildPdfBuffer(pdf.pages.map(ops => ops.join('\n')));
}

module.exports = {
    COMPANY_PROFILE,
    DEFAULT_TERMS_AND_WARRANTY,
    renderEstimatePdf,
};

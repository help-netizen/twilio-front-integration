/**
 * Client-facing estimate PDF renderer.
 *
 * This intentionally avoids external binary/rendering dependencies. It writes a
 * compact PDF with standard Helvetica fonts, predictable page breaks, and a
 * document layout close to the in-app client preview.
 *
 * Customization: accepts an optional `descriptor` (DocumentTemplateDescriptor v1).
 * When omitted, falls back to the factory descriptor for `document_type='estimate'`.
 * See `services/documentTemplates/factory.js`.
 */

const { getFactory, DEFAULT_TERMS_AND_WARRANTY: FACTORY_TERMS } = require('./documentTemplates/factory');

// Backwards-compatible exports for any pre-F015 importer.
const COMPANY_PROFILE = (() => {
    const f = getFactory('estimate').brand;
    return {
        name: f.name,
        address: f.address,
        email: f.email,
        phone: f.phone,
        ach: {
            bank: f.ach?.bank,
            routingNumber: f.ach?.routing_number,
            accountNumber: f.ach?.account_number,
        },
    };
})();
const DEFAULT_TERMS_AND_WARRANTY = FACTORY_TERMS;

const PAGE = { width: 612, height: 792, margin: 42 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const SECTION_GAP = 12;

/**
 * Layout preset tokens for the PDF renderer. Mirrors the Light/Bold/Minimal
 * presets in TemplateLivePreview (HTML), adjusted for PDF point units.
 *
 * Multi-column layouts (`width`, `glue_with_next`) and `text_align` are
 * NOT honored by the PDF renderer (it remains a sequential single-column
 * builder). Those features are reflected in the in-app HTML preview only.
 */
const PRESETS = {
    light: {
        brandName: 19, brandSub: 9,
        estimateNumber: 15, estimateMeta: 9,
        sectionLabel: 9, sectionGapTop: 14, sectionGapBottom: 14,
        body: 10, bodyLine: 14,
        item: 10.5, itemDesc: 9,
        totalsLabel: 10, totalLabel: 12, totalValue: 12,
        terms: 7.8, termsLine: 9.8,
        ach: { bank: 9, label: 8, value: 8.8 },
    },
    bold: {
        brandName: 24, brandSub: 10,
        estimateNumber: 22, estimateMeta: 10,
        sectionLabel: 11, sectionGapTop: 16, sectionGapBottom: 16,
        body: 11, bodyLine: 15,
        item: 12, itemDesc: 10,
        totalsLabel: 11, totalLabel: 14, totalValue: 16,
        terms: 8.5, termsLine: 11,
        ach: { bank: 10, label: 9, value: 9.8 },
    },
    minimal: {
        brandName: 16, brandSub: 8,
        estimateNumber: 14, estimateMeta: 8.5,
        sectionLabel: 8, sectionGapTop: 12, sectionGapBottom: 12,
        body: 9, bodyLine: 12.5,
        item: 9.5, itemDesc: 8.5,
        totalsLabel: 9, totalLabel: 10, totalValue: 11,
        terms: 7.2, termsLine: 9.2,
        ach: { bank: 8, label: 7.5, value: 8 },
    },
};

function getPresetTokens(descriptor) {
    const name = descriptor.layout_preset || 'light';
    const base = PRESETS[name] || PRESETS.light;
    const scale = Number(descriptor.font_scale) || 1;
    if (scale === 1) return base;
    // Scale every numeric leaf proportionally.
    const scaleObj = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' ? v * scale : (typeof v === 'object' ? scaleObj(v) : v)]));
    return scaleObj(base);
}

function descriptorOrFactory(descriptor) {
    return descriptor && descriptor.schema_version === 1 ? descriptor : getFactory('estimate');
}

function findSection(descriptor, key) {
    return descriptor.sections.find(s => s.key === key) || null;
}

function isVisible(descriptor, key) {
    const s = findSection(descriptor, key);
    return Boolean(s && s.visible);
}

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

function hexToRgb(hex) {
    const value = String(hex || '#000000').replace('#', '');
    const int = parseInt(value, 16);
    return [
        ((int >> 16) & 255) / 255,
        ((int >> 8) & 255) / 255,
        (int & 255) / 255,
    ];
}

function rgb(hex) {
    return hexToRgb(hex).map(n => n.toFixed(4)).join(' ');
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

function textWidth(value, size) {
    return normalizeText(value).length * size * 0.51;
}

function wrapText(text, size, maxWidth) {
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
            if (!line || textWidth(candidate, size) <= maxWidth) {
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

function textBlockHeight(text, width, { size = 10, lineHeight = 14 } = {}) {
    return wrapText(text, size, width).length * lineHeight;
}

function itemRate(item) {
    const qty = Number(item.quantity || 1);
    const unitPrice = money(item.unit_price);
    return qty === 1 ? unitPrice : `${qty} x ${unitPrice}`;
}

class PdfCanvas {
    constructor(theme, tokens) {
        this.pages = [[]];
        this.y = PAGE.margin;
        this.theme = theme;
        this.tokens = tokens;
    }

    get ops() {
        return this.pages[this.pages.length - 1];
    }

    pdfY(topY) {
        return PAGE.height - topY;
    }

    addPage() {
        this.pages.push([]);
        this.y = PAGE.margin;
    }

    ensure(height) {
        if (this.y + height <= PAGE.height - PAGE.margin) return;
        this.addPage();
    }

    text(value, x, y, opts = {}) {
        const size = opts.size || 10;
        const font = opts.font || 'F1';
        const color = opts.color || this.theme.ink;
        this.ops.push(`BT /${font} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${this.pdfY(y).toFixed(2)} Td (${escapePdfText(value)}) Tj ET`);
    }

    rightText(value, rightX, y, options = {}) {
        const size = options.size || 10;
        this.text(value, rightX - textWidth(value, size), y, options);
    }

    line(x1, y1, x2, y2, opts = {}) {
        const color = opts.color || this.theme.border;
        const width = opts.width || 1;
        this.ops.push(`${width.toFixed(2)} w ${rgb(color)} RG ${x1.toFixed(2)} ${this.pdfY(y1).toFixed(2)} m ${x2.toFixed(2)} ${this.pdfY(y2).toFixed(2)} l S`);
    }

    rect(x, y, width, height, opts = {}) {
        const fill = opts.fill || this.theme.surface;
        const stroke = opts.stroke || null;
        const strokeWidth = opts.strokeWidth || 1;
        this.ops.push(`${rgb(fill)} rg ${x.toFixed(2)} ${(this.pdfY(y) - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
        if (stroke) {
            this.ops.push(`${strokeWidth.toFixed(2)} w ${rgb(stroke)} RG ${x.toFixed(2)} ${(this.pdfY(y) - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`);
        }
    }

    paragraph(text, x, y, width, opts = {}) {
        const size = opts.size || 10;
        const lineHeight = opts.lineHeight || 14;
        const font = opts.font || 'F1';
        const color = opts.color || this.theme.ink;
        const lines = wrapText(text, size, width);
        let cursor = y;
        for (const line of lines) {
            this.ensure(lineHeight + 4);
            if (line) this.text(line, x, cursor, { size, lineHeight, font, color });
            cursor += lineHeight;
        }
        return cursor;
    }

    heading(label) {
        const t = this.tokens;
        this.ensure(t.sectionGapTop + t.sectionGapBottom + 6);
        this.text(label.toUpperCase(), PAGE.margin, this.y, { size: t.sectionLabel, font: 'F2', color: this.theme.muted });
        this.y += t.sectionGapTop;
        this.line(PAGE.margin, this.y, PAGE.width - PAGE.margin, this.y);
        this.y += t.sectionGapBottom;
    }

    footer(pageIndex) {
        const pageNumber = pageIndex + 1;
        const label = `Page ${pageNumber}`;
        this.pages[pageIndex].push(`BT /F1 8 Tf ${rgb(this.theme.muted)} rg ${(PAGE.width - PAGE.margin - textWidth(label, 8)).toFixed(2)} 26.00 Td (${label}) Tj ET`);
    }

    finish(showPageNumber) {
        if (showPageNumber) {
            this.pages.forEach((_, idx) => this.footer(idx));
        }
    }
}

function renderLogo(pdf, _estimate, descriptor) {
    // P0: PDF cannot embed raster images (renderer is text-only).
    // Reserve a small block with the brand name as a textual fallback.
    // Real image embedding is P1.
    const left = PAGE.margin;
    const brand = descriptor.brand;
    pdf.text(brand.name, left, pdf.y, { size: 16, font: 'F2' });
    pdf.y += 28;
}

function renderBrand(pdf, _estimate, descriptor) {
    const left = PAGE.margin;
    const brand = descriptor.brand;
    const t = pdf.tokens;
    pdf.text(brand.name, left, pdf.y, { size: t.brandName, font: 'F2' });
    pdf.text(brand.address, left, pdf.y + t.brandName + 1, { size: t.brandSub, color: pdf.theme.muted });
    pdf.text(`${brand.email}  |  ${brand.phone}`, left, pdf.y + t.brandName + t.brandSub + 6, { size: t.brandSub, color: pdf.theme.muted });
    pdf.y += t.brandName + 2 * t.brandSub + 20;
    pdf.line(left, pdf.y, PAGE.width - PAGE.margin, pdf.y);
    pdf.y += 20;
}

function renderDocumentMeta(pdf, estimate) {
    const left = PAGE.margin;
    const right = PAGE.width - PAGE.margin;
    const t = pdf.tokens;
    pdf.rightText(estimate.estimate_number || 'ESTIMATE', right, pdf.y, { size: t.estimateNumber, font: 'F2' });
    pdf.rightText(`Date: ${formatDate(estimate.updated_at || estimate.created_at)}`, right, pdf.y + t.estimateNumber + 4, { size: t.estimateMeta, color: pdf.theme.muted });
    pdf.rightText(`Status: ${estimate.status || 'draft'}`, right, pdf.y + t.estimateNumber + t.estimateMeta + 8, { size: t.estimateMeta, color: pdf.theme.muted });
    pdf.y += t.estimateNumber + 2 * t.estimateMeta + 20;
    pdf.line(left, pdf.y, right, pdf.y);
    pdf.y += 20;
}

function renderHeader(pdf, estimate, descriptor) {
    // Backwards-compat: if document_meta section is also visible, brand-only here;
    // otherwise render combined header (logo+brand left, estimate meta right).
    const hasMeta = descriptor.sections.some(s => s.key === 'document_meta' && s.visible);
    if (hasMeta) {
        renderBrand(pdf, estimate, descriptor);
        return;
    }
    const left = PAGE.margin;
    const right = PAGE.width - PAGE.margin;
    const brand = descriptor.brand;
    const t = pdf.tokens;

    pdf.text(brand.name, left, pdf.y, { size: t.brandName, font: 'F2' });
    pdf.text(brand.address, left, pdf.y + t.brandName + 1, { size: t.brandSub, color: pdf.theme.muted });
    pdf.text(`${brand.email}  |  ${brand.phone}`, left, pdf.y + t.brandName + t.brandSub + 6, { size: t.brandSub, color: pdf.theme.muted });

    pdf.rightText(estimate.estimate_number || 'ESTIMATE', right, pdf.y, { size: t.estimateNumber, font: 'F2' });
    pdf.rightText(`Date: ${formatDate(estimate.updated_at || estimate.created_at)}`, right, pdf.y + t.estimateNumber + 4, { size: t.estimateMeta, color: pdf.theme.muted });
    pdf.rightText(`Status: ${estimate.status || 'draft'}`, right, pdf.y + t.estimateNumber + t.estimateMeta + 8, { size: t.estimateMeta, color: pdf.theme.muted });
    pdf.y += t.brandName + 2 * t.brandSub + 20;
    pdf.line(left, pdf.y, right, pdf.y);
    pdf.y += 20;
}

function renderAch(pdf, descriptor) {
    const ach = descriptor.brand.ach;
    if (!ach) return;
    const t = pdf.tokens.ach;
    const achSection = descriptor.sections.find(s => s.key === 'ach');
    const inline = Boolean(achSection && achSection.inline);
    const boxTop = pdf.y;
    const labelX = PAGE.margin + 12;
    const valueX = PAGE.margin + 126;

    if (inline) {
        // Single-row layout: ACH PAYMENTS | Bank | Routing | Account
        pdf.ensure(40);
        pdf.rect(PAGE.margin, boxTop, CONTENT_WIDTH, 30, { fill: pdf.theme.faint, stroke: pdf.theme.border });
        pdf.text('ACH PAYMENTS', labelX, boxTop + 19, { size: t.label, font: 'F2', color: pdf.theme.muted });
        pdf.text(`Bank: ${ach.bank || ''}`, labelX + 90, boxTop + 19, { size: t.value });
        pdf.text(`Routing: ${ach.routing_number || ''}`, labelX + 230, boxTop + 19, { size: t.value });
        pdf.text(`Account: ${ach.account_number || ''}`, labelX + 360, boxTop + 19, { size: t.value });
        pdf.y += 30 + SECTION_GAP;
        return;
    }

    pdf.ensure(60);
    pdf.rect(PAGE.margin, boxTop, CONTENT_WIDTH, 48, { fill: pdf.theme.faint, stroke: pdf.theme.border });
    pdf.text('ACH PAYMENTS', labelX, boxTop + 16, { size: t.label, font: 'F2', color: pdf.theme.muted });
    pdf.text(ach.bank || '', valueX, boxTop + 16, { size: t.bank, font: 'F2' });
    pdf.text(`Routing Number: ${ach.routing_number || ''}`, labelX, boxTop + 32, { size: t.value });
    pdf.text(`Account Number: ${ach.account_number || ''}`, valueX + 132, boxTop + 32, { size: t.value });
    pdf.y += 48 + SECTION_GAP;
}

function writeBoxLines(pdf, x, y, width, label, lines, { titleSize = 10 } = {}) {
    pdf.text(label, x + 10, y + 16, { size: 7.5, font: 'F2', color: pdf.theme.muted });
    let cursor = y + 31;
    const [firstLine, ...rest] = lines.filter(Boolean);
    if (firstLine) {
        for (const wrapped of wrapText(firstLine, titleSize, width - 20)) {
            if (!wrapped) continue;
            pdf.text(wrapped, x + 10, cursor, { size: titleSize, font: 'F2' });
            cursor += titleSize + 4;
        }
    }
    for (const line of rest) {
        for (const wrapped of wrapText(line, 8.5, width - 20)) {
            if (!wrapped) continue;
            pdf.text(wrapped, x + 10, cursor, { size: 8.5, color: pdf.theme.muted });
            cursor += 11;
        }
    }
}

function renderClientAndAddresses(pdf, estimate) {
    const left = PAGE.margin;
    const gap = 12;
    const boxWidth = (CONTENT_WIDTH - gap) / 2;
    const serviceX = left + boxWidth + gap;
    const boxTop = pdf.y;
    const boxHeight = 110;
    const billingAddress = estimate.billing_address || estimate.service_address || '';
    const serviceAddress = estimate.service_address || billingAddress || '';

    pdf.ensure(boxHeight + SECTION_GAP);
    pdf.rect(left, boxTop, boxWidth, boxHeight, { fill: pdf.theme.faint, stroke: pdf.theme.border });
    pdf.rect(serviceX, boxTop, boxWidth, boxHeight, { fill: pdf.theme.surface, stroke: pdf.theme.border });

    writeBoxLines(pdf, left, boxTop, boxWidth, 'PREPARED FOR', [
        estimate.contact_name || 'Customer',
        estimate.contact_email,
        estimate.contact_phone,
        billingAddress || null,
    ], { titleSize: 10 });
    writeBoxLines(pdf, serviceX, boxTop, boxWidth, 'SERVICE LOCATION', [
        estimate.contact_name || 'Customer',
        estimate.contact_email,
        estimate.contact_phone,
        serviceAddress || null,
    ], { titleSize: 10 });

    pdf.y += boxHeight + SECTION_GAP;
}

function renderSummary(pdf, estimate) {
    if (!estimate.summary) return;
    const t = pdf.tokens;
    pdf.heading('Summary');
    pdf.y = pdf.paragraph(estimate.summary, PAGE.margin, pdf.y, CONTENT_WIDTH, {
        size: t.body,
        lineHeight: t.bodyLine,
        color: pdf.theme.ink,
    }) + 10;
}

function renderItems(pdf, estimate) {
    const items = estimate.items || [];
    if (items.length === 0) return;

    pdf.heading('Items');

    const nameX = PAGE.margin;
    const rateX = PAGE.width - PAGE.margin - 165;
    const amountX = PAGE.width - PAGE.margin;
    const tableRight = PAGE.width - PAGE.margin;

    pdf.ensure(30);
    pdf.rect(PAGE.margin, pdf.y - 4, CONTENT_WIDTH, 24, { fill: pdf.theme.faint });
    pdf.text('Item', nameX + 10, pdf.y + 11, { size: 8, font: 'F2', color: pdf.theme.muted });
    pdf.text('Rate', rateX, pdf.y + 11, { size: 8, font: 'F2', color: pdf.theme.muted });
    pdf.rightText('Amount', amountX - 10, pdf.y + 11, { size: 8, font: 'F2', color: pdf.theme.muted });
    pdf.y += 31;

    const tk = pdf.tokens;
    for (const item of items) {
        const descLines = item.description ? wrapText(item.description, tk.itemDesc, 335) : [];
        const rowHeight = Math.max(48, 38 + descLines.length * 12);
        pdf.ensure(rowHeight + 4);

        const rowTop = pdf.y - 6;
        pdf.rect(PAGE.margin, rowTop, CONTENT_WIDTH, rowHeight, { fill: pdf.theme.surface, stroke: pdf.theme.border });
        pdf.text(item.name || 'Item', nameX + 10, pdf.y + 8, { size: tk.item, font: 'F2' });
        pdf.text(itemRate(item), rateX, pdf.y + 8, { size: tk.itemDesc, color: pdf.theme.muted });
        pdf.rightText(money(item.amount), amountX - 10, pdf.y + 8, { size: tk.item, font: 'F2' });

        let descY = pdf.y + 24;
        for (const line of descLines) {
            pdf.text(line, nameX + 10, descY, { size: tk.itemDesc, color: pdf.theme.muted });
            descY += 12;
        }

        pdf.line(rateX - 18, rowTop, rateX - 18, rowTop + rowHeight, { color: pdf.theme.border });
        pdf.line(tableRight - 112, rowTop, tableRight - 112, rowTop + rowHeight, { color: pdf.theme.border });
        pdf.y += rowHeight + 8;
    }
}

function renderTotals(pdf, estimate) {
    const boxWidth = 225;
    const boxX = PAGE.width - PAGE.margin - boxWidth;
    const valueX = PAGE.width - PAGE.margin - 14;
    const labelX = boxX + 14;
    const rows = [['Subtotal', money(estimate.subtotal)]];

    if (Number(estimate.discount_amount || 0) > 0) {
        rows.push(['Discount', `-${money(estimate.discount_amount)}`]);
    }
    if (Number(estimate.tax_amount || 0) > 0) {
        rows.push(['Tax', money(estimate.tax_amount)]);
    }

    const tk = pdf.tokens;
    const boxHeight = 44 + rows.length * 18;
    pdf.ensure(boxHeight + 10);
    pdf.rect(boxX, pdf.y, boxWidth, boxHeight, { fill: pdf.theme.faint, stroke: pdf.theme.border });
    let y = pdf.y + 17;

    for (const [label, value] of rows) {
        pdf.text(label, labelX, y, { size: tk.totalsLabel, color: pdf.theme.muted });
        pdf.rightText(value, valueX, y, { size: tk.totalsLabel, color: label === 'Discount' ? pdf.theme.danger : pdf.theme.ink });
        y += 18;
    }

    pdf.line(labelX, y - 3, valueX, y - 3);
    y += 16;
    pdf.text('Total', labelX, y, { size: tk.totalLabel, font: 'F2' });
    pdf.rightText(money(estimate.total), valueX, y, { size: tk.totalValue, font: 'F2' });
    pdf.y += boxHeight + 18;
}

function renderTerms(pdf, descriptor) {
    const section = findSection(descriptor, 'terms');
    const body = (section && section.body_md) || '';
    if (!body) return;
    const size = pdf.tokens.terms;
    const lineHeight = pdf.tokens.termsLine;
    const height = 34 + textBlockHeight(body, CONTENT_WIDTH, { size, lineHeight }) + 8;
    pdf.ensure(height);
    pdf.heading('Terms & Warranty');
    pdf.y = pdf.paragraph(body, PAGE.margin, pdf.y, CONTENT_WIDTH, {
        size,
        lineHeight,
        color: pdf.theme.muted,
    }) + 8;
}

const SECTION_RENDERERS = {
    logo: (pdf, estimate, descriptor) => renderLogo(pdf, estimate, descriptor),
    header: renderHeader,
    document_meta: (pdf, estimate) => renderDocumentMeta(pdf, estimate),
    ach: (pdf, _est, descriptor) => renderAch(pdf, descriptor),
    client_addresses: (pdf, estimate) => renderClientAndAddresses(pdf, estimate),
    summary: (pdf, estimate) => renderSummary(pdf, estimate),
    items: (pdf, estimate) => renderItems(pdf, estimate),
    totals: (pdf, estimate) => renderTotals(pdf, estimate),
    terms: (pdf, _est, descriptor) => renderTerms(pdf, descriptor),
};

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

/**
 * Renders an estimate to a PDF Buffer using @react-pdf/renderer driven by the
 * stored document template descriptor. The output mirrors `TemplateLivePreview`
 * (HTML preview) so PDF and preview stay visually consistent.
 *
 * Returns Buffer (sync, awaiting `renderToBuffer` resolved before return).
 */
async function renderEstimatePdf(estimate, descriptor) {
    const desc = descriptorOrFactory(descriptor);
    // @react-pdf/renderer ships ESM only — load via dynamic import.
    const reactPdf = await import('@react-pdf/renderer');
    const { buildEstimatePdfElement } = require('./documentTemplates/estimatePdfDocument');
    const element = buildEstimatePdfElement({ estimate, descriptor: desc }, reactPdf);
    return await reactPdf.renderToBuffer(element);
}

module.exports = {
    COMPANY_PROFILE,
    DEFAULT_TERMS_AND_WARRANTY,
    renderEstimatePdf,
};

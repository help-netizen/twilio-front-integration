/**
 * React-PDF document for invoices. Mirrors the estimate PDF document but with
 * invoice-specific labels and a totals section that surfaces payment status
 * (amount paid + balance due) prominently.
 *
 * Reuses presets, glue groups, width-based layout, and section dispatching
 * from the estimate document so visual feel stays consistent.
 */

'use strict';

const React = require('react');
const e = React.createElement;

const WIDTH_PCT = { full: '100%', two_thirds: '66.6667%', half: '50%', third: '33.3333%' };

const PRESETS = {
    light: {
        sectionPaddingV: 14, sectionPaddingH: 22,
        headingSize: 9, headingTransform: 'uppercase', headingLetterSpacing: 1.4, headingWeight: 'semibold',
        accentBar: { width: 2, height: 14, visible: true },
        estimateLabelSize: 8, estimateLabelLetterSpacing: 1.6,
        estimateNumberSize: 22, estimateNumberWeight: 'bold',
        estimateMetaSize: 10,
        brandNameSize: 16, brandNameWeight: 'semibold',
        brandSubSize: 9.5,
        logoMaxHeight: 64,
        itemNameSize: 11, itemNameWeight: 'semibold',
        itemDescSize: 9.5,
        itemAmountSize: 11, itemAmountWeight: 'semibold',
        rowDividerWidth: 0.5,
        totalsLabelSize: 10, totalsValueSize: 10,
        totalLabelSize: 12, totalLabelWeight: 'semibold',
        totalValueSize: 16, totalValueWeight: 'bold',
        totalDividerWidth: 1.5,
        termsSize: 8, termsLine: 12,
        summarySize: 11, summaryLine: 15,
        statusBadgeSize: 9,
    },
    bold: {
        sectionPaddingV: 18, sectionPaddingH: 28,
        headingSize: 12, headingTransform: 'uppercase', headingLetterSpacing: 1.6, headingWeight: 'bold',
        accentBar: { width: 4, height: 18, visible: true },
        estimateLabelSize: 9, estimateLabelLetterSpacing: 1.8,
        estimateNumberSize: 32, estimateNumberWeight: 'extrabold',
        estimateMetaSize: 11,
        brandNameSize: 22, brandNameWeight: 'bold',
        brandSubSize: 11,
        logoMaxHeight: 84,
        itemNameSize: 13, itemNameWeight: 'bold',
        itemDescSize: 11,
        itemAmountSize: 14, itemAmountWeight: 'extrabold',
        rowDividerWidth: 1.2,
        totalsLabelSize: 11, totalsValueSize: 11,
        totalLabelSize: 14, totalLabelWeight: 'bold',
        totalValueSize: 24, totalValueWeight: 'extrabold',
        totalDividerWidth: 2.5,
        termsSize: 9, termsLine: 13,
        summarySize: 12, summaryLine: 16,
        statusBadgeSize: 10,
    },
    minimal: {
        sectionPaddingV: 10, sectionPaddingH: 22,
        headingSize: 9, headingTransform: 'none', headingLetterSpacing: 0, headingWeight: 'medium',
        accentBar: { width: 0, height: 0, visible: false },
        estimateLabelSize: 8, estimateLabelLetterSpacing: 1,
        estimateNumberSize: 14, estimateNumberWeight: 'medium',
        estimateMetaSize: 9,
        brandNameSize: 13, brandNameWeight: 'medium',
        brandSubSize: 9,
        logoMaxHeight: 52,
        itemNameSize: 10, itemNameWeight: 'medium',
        itemDescSize: 9,
        itemAmountSize: 10, itemAmountWeight: 'normal',
        rowDividerWidth: 0.4,
        totalsLabelSize: 9, totalsValueSize: 9,
        totalLabelSize: 10, totalLabelWeight: 'medium',
        totalValueSize: 12, totalValueWeight: 'medium',
        totalDividerWidth: 0.6,
        termsSize: 7.5, termsLine: 10.5,
        summarySize: 10, summaryLine: 13,
        statusBadgeSize: 8,
    },
};

function getTokens(descriptor) {
    const name = descriptor.layout_preset || 'light';
    const base = PRESETS[name] || PRESETS.light;
    const scale = Number(descriptor.font_scale) || 1;
    if (scale === 1) return base;
    const out = {};
    for (const [k, v] of Object.entries(base)) {
        if (typeof v === 'number') out[k] = v * scale;
        else if (v && typeof v === 'object') {
            out[k] = {};
            for (const [k2, v2] of Object.entries(v)) {
                out[k][k2] = typeof v2 === 'number' && k2 !== 'width' ? v2 * scale : v2;
            }
        } else out[k] = v;
    }
    return out;
}

function money(value) {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildGlueGroups(sections) {
    const groups = [];
    for (const s of sections) {
        const last = groups[groups.length - 1];
        const prev = last && last[last.length - 1];
        if (prev && prev.glue_with_next) last.push(s);
        else groups.push([s]);
    }
    return groups;
}

function alignFor(s) {
    return s.text_align || (s.key === 'document_meta' ? 'right' : 'left');
}

/** Payment status (paid / partial / overdue / due / void). */
function paymentStatusLabel(invoice) {
    const status = (invoice.status || 'draft').toLowerCase();
    if (status === 'void') return { label: 'VOID', tone: 'danger' };
    if (status === 'paid') return { label: 'PAID', tone: 'success' };
    if (status === 'partial') return { label: 'PARTIALLY PAID', tone: 'warning' };
    if (status === 'overdue') return { label: 'OVERDUE', tone: 'danger' };
    if (status === 'refunded') return { label: 'REFUNDED', tone: 'danger' };
    return { label: 'AMOUNT DUE', tone: 'neutral' };
}

let P = null;

function buildInvoicePdfElement({ invoice, descriptor }, primitives) {
    P = primitives;
    return e(InvoicePdfDocument, { invoice, descriptor });
}

function SectionHeading({ label, tokens, accent, muted }) {
    const bar = tokens.accentBar;
    return e(P.View, { style: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 } },
        bar.visible && e(P.View, { style: { width: bar.width, height: bar.height, backgroundColor: accent, borderRadius: 1, marginRight: 6 } }),
        e(P.Text, { style: {
            fontSize: tokens.headingSize, color: muted, fontFamily: 'Helvetica-Bold',
            letterSpacing: tokens.headingLetterSpacing, textTransform: tokens.headingTransform,
        } }, label)
    );
}

function renderSection(s, descriptor, invoice, tokens) {
    const theme = descriptor.theme;
    const accent = theme.accent || '#0f766e';
    const muted = theme.muted || '#5f7085';
    const ink = theme.ink || '#172033';
    const danger = theme.danger || '#be123c';
    const border = theme.border || '#d8e0ea';
    const padding = { paddingVertical: tokens.sectionPaddingV, paddingHorizontal: tokens.sectionPaddingH };
    const align = alignFor(s);

    if (s.key === 'logo') {
        const logo = descriptor.brand.logo_url;
        if (logo) {
            return e(P.View, { style: { ...padding, alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' } },
                e(P.Image, { src: logo, style: { maxHeight: tokens.logoMaxHeight, objectFit: 'contain' } })
            );
        }
        const sz = tokens.logoMaxHeight;
        return e(P.View, { style: { ...padding, alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' } },
            e(P.View, { style: { width: sz, height: sz, borderWidth: 1, borderColor: border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' } },
                e(P.Text, { style: { fontSize: 7, color: muted, letterSpacing: 1, textTransform: 'uppercase' } }, 'No logo'))
        );
    }

    if (s.key === 'header') {
        const brand = descriptor.brand;
        const hasMeta = descriptor.sections.some(x => x.key === 'document_meta' && x.visible);
        const hasLogo = descriptor.sections.some(x => x.key === 'logo' && x.visible);
        return e(P.View, { style: { ...padding, flexDirection: 'row', alignItems: 'flex-start' } },
            !hasLogo && brand.logo_url && e(P.Image, { src: brand.logo_url, style: { width: 40, height: 40, marginRight: 10, objectFit: 'contain' } }),
            e(P.View, { style: { flexGrow: 1 } },
                e(P.Text, { style: { fontSize: tokens.brandNameSize, fontFamily: 'Helvetica-Bold', color: ink } }, brand.name),
                e(P.Text, { style: { fontSize: tokens.brandSubSize, color: muted, marginTop: 2 } }, brand.address || ''),
                e(P.Text, { style: { fontSize: tokens.brandSubSize, color: muted } }, brand.email || ''),
                e(P.Text, { style: { fontSize: tokens.brandSubSize, color: muted } }, brand.phone || ''),
            ),
            !hasMeta && renderInlineMeta(invoice, tokens, { accent, muted, ink })
        );
    }

    if (s.key === 'document_meta') {
        return e(P.View, { style: { ...padding, textAlign: align } },
            e(P.Text, { style: { fontSize: tokens.estimateLabelSize, color: muted, letterSpacing: tokens.estimateLabelLetterSpacing, textTransform: 'uppercase' } }, 'Invoice'),
            e(P.Text, { style: { fontSize: tokens.estimateNumberSize, color: accent, fontFamily: 'Helvetica-Bold' } }, (invoice.invoice_number || 'INVOICE').replace(/^INVOICE\s+/i, '')),
            e(P.Text, { style: { fontSize: tokens.estimateMetaSize, color: muted, marginTop: 6 } }, 'Issued: ', e(P.Text, { style: { color: ink } }, formatDate(invoice.created_at))),
            invoice.due_date && e(P.Text, { style: { fontSize: tokens.estimateMetaSize, color: muted } }, 'Due: ', e(P.Text, { style: { color: ink, fontFamily: 'Helvetica-Bold' } }, formatDate(invoice.due_date))),
            e(P.Text, { style: { fontSize: tokens.estimateMetaSize, color: muted, marginTop: 4 } }, 'Status: ', e(P.Text, { style: { color: ink } }, (invoice.status || 'draft').toUpperCase())),
        );
    }

    if (s.key === 'ach') {
        const ach = descriptor.brand.ach;
        if (!ach) return null;
        const inline = Boolean(s.inline);
        return e(P.View, { style: padding },
            e(SectionHeading, { label: 'ACH Payments', tokens, accent, muted }),
            inline
                ? e(P.View, { style: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, fontSize: 11 } },
                    e(P.Text, { style: { fontSize: 11 } }, e(P.Text, { style: { color: muted } }, 'Bank: '), e(P.Text, { style: { fontFamily: 'Helvetica-Bold' } }, ach.bank || '')),
                    e(P.Text, { style: { fontSize: 11 } }, e(P.Text, { style: { color: muted } }, 'Routing: '), ach.routing_number || ''),
                    e(P.Text, { style: { fontSize: 11 } }, e(P.Text, { style: { color: muted } }, 'Account: '), ach.account_number || ''),
                )
                : e(P.View, null,
                    e(P.Text, { style: { fontSize: 11 } }, e(P.Text, { style: { color: muted } }, 'Bank: '), e(P.Text, { style: { fontFamily: 'Helvetica-Bold' } }, ach.bank || '')),
                    e(P.Text, { style: { fontSize: 11, marginTop: 1 } }, e(P.Text, { style: { color: muted } }, 'Routing: '), ach.routing_number || ''),
                    e(P.Text, { style: { fontSize: 11, marginTop: 1 } }, e(P.Text, { style: { color: muted } }, 'Account: '), ach.account_number || ''),
                )
        );
    }

    if (s.key === 'client_addresses') {
        const billing = invoice.billing_address || invoice.service_address || '';
        const service = invoice.service_address || invoice.billing_address || '';
        const col = (label, addr) => e(P.View, { style: { flexBasis: '50%', flexGrow: 1, paddingRight: 16 } },
            e(SectionHeading, { label, tokens, accent, muted }),
            e(P.Text, { style: { fontSize: 11, fontFamily: 'Helvetica-Bold' } }, invoice.contact_name || 'Customer'),
            e(P.Text, { style: { fontSize: 10, color: muted, marginTop: 1 } }, invoice.contact_email || ''),
            e(P.Text, { style: { fontSize: 10, color: muted } }, invoice.contact_phone || ''),
            e(P.Text, { style: { fontSize: 10, marginTop: 4 } }, addr),
        );
        return e(P.View, { style: { ...padding, flexDirection: 'row' } },
            col('Bill to', billing),
            col('Service location', service),
        );
    }

    if (s.key === 'summary') {
        const text = invoice.summary || invoice.notes || '';
        if (!text) return null;
        return e(P.View, { style: padding },
            e(SectionHeading, { label: 'Summary', tokens, accent, muted }),
            e(P.Text, { style: { fontSize: tokens.summarySize, lineHeight: tokens.summaryLine / tokens.summarySize, color: ink } }, text),
        );
    }

    if (s.key === 'items') {
        const items = invoice.items || [];
        return e(P.View, { style: padding },
            e(SectionHeading, { label: 'Items', tokens, accent, muted }),
            e(P.View, { style: { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: tokens.rowDividerWidth, borderBottomColor: border } },
                e(P.Text, { style: { flexGrow: 1, fontSize: 8, color: muted, letterSpacing: 1.4, textTransform: 'uppercase' } }, 'Item'),
                e(P.Text, { style: { width: 110, fontSize: 8, color: muted, letterSpacing: 1.4, textTransform: 'uppercase' } }, 'Qty x rate'),
                e(P.Text, { style: { width: 80, fontSize: 8, color: muted, letterSpacing: 1.4, textTransform: 'uppercase', textAlign: 'right' } }, 'Amount'),
            ),
            ...items.map((it, idx) => e(P.View, {
                key: String(it.id || idx),
                style: { flexDirection: 'row', paddingVertical: 8, alignItems: 'flex-start', borderBottomWidth: tokens.rowDividerWidth, borderBottomColor: border },
            },
                e(P.View, { style: { flexGrow: 1, paddingRight: 8 } },
                    e(P.Text, { style: { fontSize: tokens.itemNameSize, fontFamily: 'Helvetica-Bold' } }, it.name || 'Item'),
                    it.description && e(P.Text, { style: { fontSize: tokens.itemDescSize, color: muted, marginTop: 2 } }, it.description),
                ),
                e(P.Text, { style: { width: 110, fontSize: 10, color: muted } }, `${Number(it.quantity || 1)} x ${money(it.unit_price)}`),
                e(P.Text, { style: { width: 80, fontSize: tokens.itemAmountSize, fontFamily: 'Helvetica-Bold', textAlign: 'right' } }, money(it.amount)),
            )),
        );
    }

    if (s.key === 'totals') {
        const subtotal = Number(invoice.subtotal || 0);
        const discount = Number(invoice.discount_amount || 0);
        const tax = Number(invoice.tax_amount || 0);
        const total = Number(invoice.total || 0);
        const paid = Number(invoice.amount_paid || 0);
        const balance = Number(invoice.balance_due ?? (total - paid));
        const status = paymentStatusLabel(invoice);
        const balanceColor = status.tone === 'success' ? '#059669'
            : status.tone === 'danger' ? danger
            : status.tone === 'warning' ? '#b45309'
            : accent;
        return e(P.View, { style: { ...padding, flexDirection: 'row', justifyContent: 'flex-end' } },
            e(P.View, { style: { width: 240 } },
                e(P.View, { style: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 } },
                    e(P.Text, { style: { fontSize: tokens.totalsLabelSize, color: muted } }, 'Subtotal'),
                    e(P.Text, { style: { fontSize: tokens.totalsValueSize } }, money(subtotal)),
                ),
                discount > 0 && e(P.View, { style: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 } },
                    e(P.Text, { style: { fontSize: tokens.totalsLabelSize, color: muted } }, 'Discount'),
                    e(P.Text, { style: { fontSize: tokens.totalsValueSize, color: danger } }, '-' + money(discount)),
                ),
                tax > 0 && e(P.View, { style: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 } },
                    e(P.Text, { style: { fontSize: tokens.totalsLabelSize, color: muted } }, 'Tax'),
                    e(P.Text, { style: { fontSize: tokens.totalsValueSize } }, money(tax)),
                ),
                e(P.View, {
                    style: {
                        flexDirection: 'row', justifyContent: 'space-between',
                        paddingTop: 8, marginTop: 6, alignItems: 'baseline',
                        borderTopWidth: tokens.totalDividerWidth, borderTopColor: accent,
                    },
                },
                    e(P.Text, { style: { fontSize: tokens.totalLabelSize, fontFamily: 'Helvetica-Bold' } }, 'Total'),
                    e(P.Text, { style: { fontSize: tokens.totalValueSize, color: accent, fontFamily: 'Helvetica-Bold' } }, money(total)),
                ),
                paid > 0 && e(P.View, { style: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, marginTop: 4 } },
                    e(P.Text, { style: { fontSize: tokens.totalsLabelSize, color: muted } }, 'Amount paid'),
                    e(P.Text, { style: { fontSize: tokens.totalsValueSize, color: '#059669' } }, '-' + money(paid)),
                ),
                e(P.View, {
                    style: {
                        marginTop: 6, paddingTop: 6, paddingHorizontal: 0,
                        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
                    },
                },
                    e(P.Text, { style: { fontSize: tokens.statusBadgeSize, color: balanceColor, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, textTransform: 'uppercase' } }, status.label),
                    e(P.Text, { style: { fontSize: tokens.totalValueSize, color: balanceColor, fontFamily: 'Helvetica-Bold' } }, money(balance)),
                ),
            ),
        );
    }

    if (s.key === 'terms') {
        const body = s.body_md || '';
        if (!body) return null;
        return e(P.View, { style: padding },
            e(SectionHeading, { label: 'Terms & Warranty', tokens, accent, muted }),
            e(P.Text, { style: { fontSize: tokens.termsSize, lineHeight: tokens.termsLine / tokens.termsSize, color: muted } }, body),
        );
    }

    return null;
}

function renderInlineMeta(invoice, tokens, { accent, muted, ink }) {
    return e(P.View, { style: { textAlign: 'right' } },
        e(P.Text, { style: { fontSize: tokens.estimateLabelSize, color: muted, letterSpacing: tokens.estimateLabelLetterSpacing, textTransform: 'uppercase' } }, 'Invoice'),
        e(P.Text, { style: { fontSize: tokens.estimateNumberSize, color: accent, fontFamily: 'Helvetica-Bold' } }, (invoice.invoice_number || 'INVOICE').replace(/^INVOICE\s+/i, '')),
        e(P.Text, { style: { fontSize: tokens.estimateMetaSize, color: muted, marginTop: 4 } }, 'Due: ', e(P.Text, { style: { color: ink } }, formatDate(invoice.due_date || invoice.created_at))),
        e(P.Text, { style: { fontSize: tokens.estimateMetaSize, color: muted } }, 'Status: ', e(P.Text, { style: { color: ink } }, (invoice.status || 'draft').toUpperCase())),
    );
}

function InvoicePdfDocument({ invoice, descriptor }) {
    const tokens = getTokens(descriptor);
    const visible = descriptor.sections.filter(s => s.visible !== false);
    const groups = buildGlueGroups(visible);
    const surface = descriptor.theme.surface || '#fbfcfe';
    const ink = descriptor.theme.ink || '#172033';
    const fontScale = Number(descriptor.font_scale) || 1;

    return e(P.Document, null,
        e(P.Page, {
            size: 'LETTER',
            style: {
                fontFamily: 'Helvetica',
                color: ink,
                backgroundColor: surface,
                paddingHorizontal: 32 * fontScale,
                paddingVertical: 32 * fontScale,
            },
        },
            e(P.View, { style: { flexDirection: 'row', flexWrap: 'wrap' } },
                ...groups.map((group, gIdx) => {
                    const totalSpan = group.reduce((acc, s) => {
                        const span = { full: 6, two_thirds: 4, half: 3, third: 2 }[s.width || 'full'];
                        return acc + span;
                    }, 0);
                    const widthFraction = Math.min(6, totalSpan) / 6;
                    const widthPct = (widthFraction * 100).toFixed(4) + '%';
                    if (group.length === 1) {
                        const s = group[0];
                        return e(P.View, { key: 'g' + gIdx, style: { width: widthPct, textAlign: alignFor(s) } },
                            renderSection(s, descriptor, invoice, tokens));
                    }
                    return e(P.View, { key: 'g' + gIdx, style: { width: widthPct, flexDirection: 'row', alignItems: 'flex-start' } },
                        ...group.map((s, i) => e(P.View, { key: i, style: { textAlign: alignFor(s) } },
                            renderSection(s, descriptor, invoice, tokens))));
                })
            )
        )
    );
}

module.exports = { buildInvoicePdfElement };

import React from 'react';
import type {
    TemplateDescriptorV1,
    SectionDescriptor,
    SectionKey,
    SectionWidth,
    LayoutPreset,
} from '../../types/documentTemplates';
import './TemplateLivePreview.css';

const WIDTH_SPAN: Record<SectionWidth, number> = { full: 6, two_thirds: 4, half: 3, third: 2 };

/**
 * Layout presets — different visual styles applied to the same descriptor.
 * Each preset is a bundle of typography + spacing tokens consumed by the
 * renderers below. Switchable from the Preview tab.
 */
interface PresetTokens {
    pagePadding: string;            // outer page padding
    sectionPadding: string;         // padding inside each section
    headingClass: string;           // section heading text style
    accentBarStyle: { width: string; height: string; visible: boolean };
    estimateLabelClass: string;
    estimateNumberClass: string;
    estimateMetaClass: string;
    brandNameClass: string;
    brandSubClass: string;
    /** Logo image max-height (Tailwind class, e.g. 'max-h-20'). Width scales proportionally. */
    logoMaxClass: string;
    itemNameClass: string;
    itemDescClass: string;
    itemAmountClass: string;
    rowDivider: string;             // borderBottom string for items table rows
    totalsLabelClass: string;
    totalsValueClass: string;
    totalLabelClass: string;
    totalValueClass: string;
    totalDividerThickness: string;  // CSS like '2px solid'
    termsClass: string;
    summaryClass: string;
}

const PRESETS: Record<LayoutPreset, PresetTokens> = {
    light: {
        pagePadding: '',
        sectionPadding: 'px-6 py-4',
        headingClass: 'text-[11px] font-semibold uppercase tracking-[0.14em]',
        accentBarStyle: { width: 'w-0.5', height: 'h-4', visible: true },
        estimateLabelClass: 'text-[10px] uppercase tracking-[0.18em]',
        estimateNumberClass: 'text-2xl font-bold leading-tight tracking-tight',
        estimateMetaClass: 'text-[12px]',
        brandNameClass: 'text-lg font-semibold leading-tight tracking-tight',
        brandSubClass: 'text-[12px] leading-relaxed',
        logoMaxClass: 'max-h-20',
        itemNameClass: 'text-[13px] font-semibold leading-snug',
        itemDescClass: 'text-[12px] mt-0.5 leading-snug',
        itemAmountClass: 'text-[13px] font-semibold tabular-nums',
        rowDivider: '1px solid',
        totalsLabelClass: 'text-[12px]',
        totalsValueClass: 'text-[12px] tabular-nums',
        totalLabelClass: 'text-[14px] font-semibold',
        totalValueClass: 'text-[18px] font-bold tabular-nums tracking-tight',
        totalDividerThickness: '2px solid',
        termsClass: 'text-[11px] leading-relaxed',
        summaryClass: 'text-[13px] leading-relaxed',
    },
    bold: {
        pagePadding: '',
        sectionPadding: 'px-8 py-6',
        headingClass: 'text-[15px] font-bold uppercase tracking-wider',
        accentBarStyle: { width: 'w-1.5', height: 'h-6', visible: true },
        estimateLabelClass: 'text-[11px] uppercase tracking-[0.18em] font-semibold',
        estimateNumberClass: 'text-4xl font-extrabold leading-tight tracking-tight',
        estimateMetaClass: 'text-[13px] font-medium',
        brandNameClass: 'text-2xl font-bold leading-tight tracking-tight',
        brandSubClass: 'text-[13px] leading-relaxed',
        logoMaxClass: 'max-h-24',
        itemNameClass: 'text-[15px] font-bold leading-snug',
        itemDescClass: 'text-[13px] mt-1 leading-snug',
        itemAmountClass: 'text-[16px] font-extrabold tabular-nums',
        rowDivider: '2px solid',
        totalsLabelClass: 'text-[13px] font-medium',
        totalsValueClass: 'text-[13px] tabular-nums font-medium',
        totalLabelClass: 'text-[16px] font-bold uppercase tracking-wider',
        totalValueClass: 'text-[28px] font-extrabold tabular-nums tracking-tight',
        totalDividerThickness: '3px solid',
        termsClass: 'text-[12px] leading-relaxed',
        summaryClass: 'text-[14px] leading-relaxed font-medium',
    },
    minimal: {
        pagePadding: '',
        sectionPadding: 'px-6 py-3',
        headingClass: 'text-[11px] font-medium',
        accentBarStyle: { width: 'w-0', height: 'h-0', visible: false },
        estimateLabelClass: 'text-[10px] uppercase tracking-wider',
        estimateNumberClass: 'text-lg font-medium leading-tight',
        estimateMetaClass: 'text-[11px]',
        brandNameClass: 'text-base font-medium leading-tight',
        brandSubClass: 'text-[11px] leading-snug',
        logoMaxClass: 'max-h-16',
        itemNameClass: 'text-[12px] font-medium leading-snug',
        itemDescClass: 'text-[11px] mt-0.5 leading-snug',
        itemAmountClass: 'text-[12px] tabular-nums',
        rowDivider: '1px dashed',
        totalsLabelClass: 'text-[11px]',
        totalsValueClass: 'text-[11px] tabular-nums',
        totalLabelClass: 'text-[12px] font-medium',
        totalValueClass: 'text-[14px] font-medium tabular-nums',
        totalDividerThickness: '1px solid',
        termsClass: 'text-[10px] leading-relaxed',
        summaryClass: 'text-[12px] leading-relaxed',
    },
};

function getPreset(d: TemplateDescriptorV1): PresetTokens {
    return PRESETS[d.layout_preset ?? 'light'];
}

export interface PreviewItem {
    id: number | string;
    name: string;
    description?: string | null;
    quantity: number;
    unit_price: number;
    amount: number;
}

export interface PreviewEstimate {
    estimate_number: string;
    status: string;
    contact_name: string;
    contact_email: string;
    contact_phone: string;
    billing_address: string;
    service_address: string;
    summary: string;
    subtotal: number;
    discount_amount: number;
    tax_amount: number;
    total: number;
    items: PreviewItem[];
    created_at: string;
    updated_at: string;
}

const FIXTURE: PreviewEstimate = {
    estimate_number: 'ESTIMATE L-1042-1',
    status: 'draft',
    contact_name: 'Jane Customer',
    contact_email: 'jane@example.com',
    contact_phone: '(555) 555-1234',
    billing_address: '12 Main Street, Springfield, MA 01103',
    service_address: '12 Main Street, Springfield, MA 01103',
    summary:
        'Failure Issue: Microwave door does not release; turntable not rotating.\nFindings: Door release mechanism worn; turntable motor seized.\nNeeds: Replace door release components and turntable motor.',
    subtotal: 375,
    discount_amount: 30,
    tax_amount: 4.06,
    total: 349.06,
    items: [
        { id: 1, name: 'Labor', description: 'Repair labor for microwave door release mechanism and turntable motor.', quantity: 1, unit_price: 280, amount: 280 },
        { id: 2, name: 'Turntable motor', description: 'OEM-compatible replacement part.', quantity: 1, unit_price: 95, amount: 95 },
    ],
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
};

function money(value: number) {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function visible(d: TemplateDescriptorV1, key: SectionKey) {
    const s = d.sections.find(x => x.key === key);
    return Boolean(s && s.visible);
}

function findBody(d: TemplateDescriptorV1, key: SectionKey) {
    return d.sections.find(x => x.key === key)?.body_md ?? '';
}

function buildGlueGroups(sections: SectionDescriptor[]): SectionDescriptor[][] {
    const groups: SectionDescriptor[][] = [];
    for (const s of sections) {
        const last = groups[groups.length - 1];
        const prev = last && last[last.length - 1];
        if (prev && prev.glue_with_next) last.push(s);
        else groups.push([s]);
    }
    return groups;
}

function spanOfGroup(group: SectionDescriptor[]): number {
    const sum = group.reduce((acc, s) => acc + WIDTH_SPAN[s.width ?? 'full'], 0);
    return Math.min(6, sum);
}

function SectionHeading({ children, color, accent, tokens }: { children: React.ReactNode; color?: string; accent?: string; tokens: PresetTokens }) {
    const bar = tokens.accentBarStyle;
    return (
        <div className="flex items-center gap-2 mb-3">
            {bar.visible && (
                <span className={`block ${bar.width} ${bar.height} rounded-sm`} style={{ background: accent || '#2563eb' }} />
            )}
            <h3 className={tokens.headingClass} style={{ color }}>{children}</h3>
        </div>
    );
}

function renderSection(key: SectionKey, descriptor: TemplateDescriptorV1, data: PreviewEstimate) {
    const { brand, theme } = descriptor;
    const ach = brand.ach;
    const tokens = getPreset(descriptor);
    const accent = theme.accent || '#2563eb';
    const muted = theme.muted || '#5f7085';

    if (key === 'logo') {
        // Placeholder dimensions track logoMaxClass so the empty-state box mirrors
        // the actual image-render footprint per preset.
        const placeholderSize = tokens.logoMaxClass.includes('24') ? 'w-24 h-24'
            : tokens.logoMaxClass.includes('16') ? 'w-16 h-16'
            : 'w-20 h-20';
        return (
            <div className={`${tokens.sectionPadding} h-full`}>
                {brand.logo_url
                    ? <img
                        src={brand.logo_url}
                        alt="logo"
                        className={`${tokens.logoMaxClass} object-contain inline-block`}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                    : <div className={`inline-flex items-center justify-center ${placeholderSize} rounded-lg border border-dashed text-[10px] uppercase tracking-wider`} style={{ borderColor: theme.border, color: muted }}>
                        No logo
                    </div>
                }
            </div>
        );
    }
    if (key === 'header') {
        const hasLogo = descriptor.sections.some(s => s.key === 'logo' && s.visible);
        const hasMeta = descriptor.sections.some(s => s.key === 'document_meta' && s.visible);
        return (
            <div className={`${tokens.sectionPadding} tlp-header flex items-start gap-3 h-full`}>
                {!hasLogo && brand.logo_url && (
                    <img
                        src={brand.logo_url}
                        alt="logo"
                        className="w-14 h-14 object-contain rounded shrink-0"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                )}
                <div className="min-w-0 flex-1">
                    <p className={tokens.brandNameClass}>{brand.name}</p>
                    <p className={`${tokens.brandSubClass} mt-1`} style={{ color: muted }}>{brand.address}</p>
                    <p className={tokens.brandSubClass} style={{ color: muted }}>{brand.email}</p>
                    <p className={tokens.brandSubClass} style={{ color: muted }}>{brand.phone}</p>
                </div>
                {!hasMeta && (
                    <div className="shrink-0">
                        <p className={tokens.estimateLabelClass} style={{ color: muted }}>Estimate</p>
                        <p className={tokens.estimateNumberClass} style={{ color: accent }}>{data.estimate_number.replace(/^ESTIMATE\s+/i, '')}</p>
                        <p className={`${tokens.estimateMetaClass} mt-1`} style={{ color: muted }}>Date: <span style={{ color: theme.ink }}>{formatDate(data.updated_at)}</span></p>
                        <p className={tokens.estimateMetaClass} style={{ color: muted }}>Status: <span style={{ color: theme.ink }}>{data.status}</span></p>
                    </div>
                )}
            </div>
        );
    }
    if (key === 'document_meta') {
        return (
            <div className={`${tokens.sectionPadding} h-full`}>
                <p className={tokens.estimateLabelClass} style={{ color: muted }}>Estimate</p>
                <p className={tokens.estimateNumberClass} style={{ color: accent }}>{data.estimate_number.replace(/^ESTIMATE\s+/i, '')}</p>
                <p className={`${tokens.estimateMetaClass} mt-2`} style={{ color: muted }}>Date: <span style={{ color: theme.ink }}>{formatDate(data.updated_at)}</span></p>
                <p className={tokens.estimateMetaClass} style={{ color: muted }}>Status: <span className="capitalize" style={{ color: theme.ink }}>{data.status}</span></p>
            </div>
        );
    }
    if (key === 'ach') {
        if (!ach) return null;
        const achSection = descriptor.sections.find(s => s.key === 'ach');
        const inline = Boolean(achSection?.inline);
        return (
            <div className={`${tokens.sectionPadding} h-full`}>
                <SectionHeading color={muted} accent={accent} tokens={tokens}>ACH Payments</SectionHeading>
                {inline ? (
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1" style={{ fontSize: '12px' }}>
                        <span><span style={{ color: muted }}>Bank: </span><span className="font-semibold">{ach.bank}</span></span>
                        <span><span style={{ color: muted }}>Routing: </span><span className="font-mono">{ach.routing_number}</span></span>
                        <span><span style={{ color: muted }}>Account: </span><span className="font-mono">{ach.account_number}</span></span>
                    </div>
                ) : (
                    <div className="space-y-0.5" style={{ fontSize: '12px' }}>
                        <p><span style={{ color: muted }}>Bank: </span><span className="font-semibold">{ach.bank}</span></p>
                        <p><span style={{ color: muted }}>Routing: </span><span className="font-mono">{ach.routing_number}</span></p>
                        <p><span style={{ color: muted }}>Account: </span><span className="font-mono">{ach.account_number}</span></p>
                    </div>
                )}
            </div>
        );
    }
    if (key === 'client_addresses') {
        return (
            <div className={`${tokens.sectionPadding} grid grid-cols-2 gap-8 h-full`}>
                <div>
                    <SectionHeading color={muted} accent={accent} tokens={tokens}>Prepared for</SectionHeading>
                    <p className="text-[13px] font-semibold">{data.contact_name}</p>
                    <p className="text-[12px] mt-0.5" style={{ color: muted }}>{data.contact_email}</p>
                    <p className="text-[12px]" style={{ color: muted }}>{data.contact_phone}</p>
                    <p className="text-[12px] mt-1.5">{data.billing_address}</p>
                </div>
                <div>
                    <SectionHeading color={muted} accent={accent} tokens={tokens}>Service location</SectionHeading>
                    <p className="text-[13px] font-semibold">{data.contact_name}</p>
                    <p className="text-[12px] mt-0.5" style={{ color: muted }}>{data.contact_email}</p>
                    <p className="text-[12px]" style={{ color: muted }}>{data.contact_phone}</p>
                    <p className="text-[12px] mt-1.5">{data.service_address}</p>
                </div>
            </div>
        );
    }
    if (key === 'summary') {
        return (
            <div className={`${tokens.sectionPadding} h-full`}>
                <SectionHeading color={muted} accent={accent} tokens={tokens}>Summary</SectionHeading>
                <p className={`whitespace-pre-wrap ${tokens.summaryClass}`}>{data.summary}</p>
            </div>
        );
    }
    if (key === 'items') {
        return (
            <div className={`${tokens.sectionPadding} h-full`}>
                <SectionHeading color={muted} accent={accent} tokens={tokens}>Items</SectionHeading>
                <div className="grid grid-cols-[1fr_auto_auto] gap-6 pb-2 text-[10px] uppercase tracking-[0.14em]" style={{ color: muted, borderBottom: `${tokens.rowDivider} ${theme.border}` }}>
                    <span>Item</span>
                    <span>Qty × rate</span>
                    <span className="text-right">Amount</span>
                </div>
                {data.items.map(it => (
                    <div
                        key={it.id}
                        className="grid grid-cols-[1fr_auto_auto] gap-6 py-3 items-baseline"
                        style={{ borderBottom: `${tokens.rowDivider} ${theme.border}` }}
                    >
                        <div>
                            <p className={tokens.itemNameClass}>{it.name}</p>
                            {it.description && <p className={tokens.itemDescClass} style={{ color: muted }}>{it.description}</p>}
                        </div>
                        <p className="text-[12px] tabular-nums" style={{ color: muted }}>{it.quantity} × {money(it.unit_price)}</p>
                        <p className={`${tokens.itemAmountClass} text-right`}>{money(it.amount)}</p>
                    </div>
                ))}
            </div>
        );
    }
    if (key === 'totals') {
        return (
            <div className={`${tokens.sectionPadding} flex justify-end h-full`}>
                <div className="w-full max-w-64">
                    <div className="flex justify-between py-1">
                        <span className={tokens.totalsLabelClass} style={{ color: muted }}>Subtotal</span>
                        <span className={tokens.totalsValueClass}>{money(data.subtotal)}</span>
                    </div>
                    {data.discount_amount > 0 && (
                        <div className="flex justify-between py-1">
                            <span className={tokens.totalsLabelClass} style={{ color: muted }}>Discount</span>
                            <span className={tokens.totalsValueClass} style={{ color: theme.danger }}>−{money(data.discount_amount)}</span>
                        </div>
                    )}
                    {data.tax_amount > 0 && (
                        <div className="flex justify-between py-1">
                            <span className={tokens.totalsLabelClass} style={{ color: muted }}>Tax</span>
                            <span className={tokens.totalsValueClass}>{money(data.tax_amount)}</span>
                        </div>
                    )}
                    <div
                        className="flex justify-between mt-2 pt-3 items-baseline"
                        style={{ borderTop: `${tokens.totalDividerThickness} ${accent}` }}
                    >
                        <span className={tokens.totalLabelClass}>Total</span>
                        <span className={tokens.totalValueClass} style={{ color: accent }}>{money(data.total)}</span>
                    </div>
                </div>
            </div>
        );
    }
    if (key === 'terms') {
        return (
            <div className={`${tokens.sectionPadding} h-full`}>
                <SectionHeading color={muted} accent={accent} tokens={tokens}>Terms & Warranty</SectionHeading>
                <p className={`whitespace-pre-wrap ${tokens.termsClass}`} style={{ color: muted }}>
                    {findBody(descriptor, 'terms')}
                </p>
            </div>
        );
    }
    return null;
}

interface Props {
    descriptor: TemplateDescriptorV1;
    /** Real estimate data for the preview. When omitted, demo fixture data is used. */
    estimate?: PreviewEstimate;
}

export function TemplateLivePreview({ descriptor, estimate }: Props) {
    const { theme } = descriptor;
    const scale = descriptor.font_scale ?? 1;
    const data: PreviewEstimate = estimate ?? FIXTURE;

    return (
        <div
            className="tlp-root rounded-xl border shadow-sm text-sm overflow-hidden"
            style={{
                background: theme.surface || '#fbfcfe',
                color: theme.ink || '#172033',
                borderColor: theme.border || '#d8e0ea',
                // CSS `zoom` scales typography + spacing proportionally
                // (supported in Chrome/Safari/Firefox 126+).
                zoom: scale,
            }}
        >
            <div className="tlp-grid grid grid-cols-6">
                {buildGlueGroups(descriptor.sections.filter(s => visible(descriptor, s.key))).map((group, gIdx) => {
                    const span = spanOfGroup(group);
                    if (group.length === 1) {
                        const s = group[0];
                        const align = s.text_align ?? (s.key === 'document_meta' ? 'right' : 'left');
                        return (
                            <div
                                key={`${s.key}:${gIdx}`}
                                className="tlp-cell"
                                style={{ '--tlp-span': span, textAlign: align } as React.CSSProperties}
                            >
                                {renderSection(s.key, descriptor, data)}
                            </div>
                        );
                    }
                    return (
                        <div
                            key={`glue:${gIdx}`}
                            style={{ '--tlp-span': span } as React.CSSProperties}
                            className="tlp-glue flex items-start"
                        >
                            {group.map((s, i) => {
                                const align = s.text_align ?? (s.key === 'document_meta' ? 'right' : 'left');
                                return (
                                    <div key={`${s.key}:${i}`} style={{ textAlign: align }} className="tlp-glue-item shrink-0">
                                        {renderSection(s.key, descriptor, data)}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
            {descriptor.footer.show_page_number !== false && (
                <div className="px-4 py-2 border-t text-[10px] text-right" style={{ borderColor: theme.border, color: theme.muted }}>
                    Page 1
                </div>
            )}
        </div>
    );
}

/**
 * PaymentDetailPanel — two-column layout matching Job/Lead/Contact panels.
 *
 * LEFT:  Header (amount + client + status pills) → Invoice tile → Job tile → Provider tile
 * RIGHT: Attachments gallery → Metadata → Check deposit
 */
import { useState, useEffect } from 'react';
import {
    Loader2, FileText, ChevronDown, Receipt,
} from 'lucide-react';
import { AttachmentsSection } from '../shared/AttachmentsSection';
import { useNavigate } from 'react-router-dom';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { PaymentDetail } from './paymentTypes';
import { formatPaymentDate, formatCurrency } from './paymentTypes';

// ─── Shared tile styles ──────────────────────────────────────────────────────

const sectionCard: React.CSSProperties = {
    padding: '16px 16px 18px',
    borderRadius: '20px',
    border: '1px solid rgba(117, 106, 89, 0.14)',
    background: 'rgba(255, 255, 255, 0.5)',
};

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--blanc-ink-3)',
    marginBottom: '8px',
};

const infoRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 0',
    borderBottom: '1px dashed rgba(117, 106, 89, 0.16)',
};

const infoLabel: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--blanc-ink-3)',
    flexShrink: 0,
    width: '72px',
};

// ─── Status colors ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
    'succeeded': '#1B8B63', 'paid': '#1B8B63',
    'failed': '#EF4444', 'refunded': '#EF4444', 'voided': '#EF4444',
    'pending': '#F59E0B', 'processing': '#F59E0B',
};

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function statusPill(label: string) {
    const color = STATUS_COLORS[label.toLowerCase()] || '#6B7280';
    return (
        <span
            className="inline-flex items-center px-3 text-xs font-semibold"
            style={{ background: hexToRgba(color, 0.1), color, minHeight: 28, borderRadius: 8 }}
        >
            {label}
        </span>
    );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PaymentDetailPanel({
    detail, loading, onClose: _onClose, onToggleDeposited,
}: {
    detail: PaymentDetail | null;
    loading: boolean;
    onClose: () => void;
    onToggleDeposited: (deposited: boolean) => void;
}) {
    const navigate = useNavigate();
    const [showMetadata, setShowMetadata] = useState(false);

    useEffect(() => {
        setShowMetadata(false);
    }, [detail?.transaction_id]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--blanc-ink-3)' }}>
                <Loader2 className="size-5 animate-spin" />
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3" style={{ color: 'var(--blanc-ink-3)' }}>
                <Receipt className="size-10 opacity-20" />
                <p className="text-sm">Unable to load payment details.</p>
            </div>
        );
    }

    const allAttachments = detail.attachments || [];
    const method = detail.display_payment_method || detail.payment_methods || '';
    const isCheck = method.toLowerCase() === 'check';

    return (
        <div className="flex flex-col h-full overflow-y-auto">

            {/* ═══ TOP: Header + Tiles (two-column on desktop) ═══ */}
            <div className="flex flex-col md:flex-row">

            {/* LEFT: Header + Tiles */}
            <div className="w-full md:w-1/2 flex flex-col">
                {/* Header */}
                <div className="px-5 pt-5 pb-3">
                    <div className="mb-2">
                        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.12em' }}>
                            Payment {method && `· ${method}`} · {formatPaymentDate(detail.payment_date)}
                        </span>
                    </div>
                    <h2
                        className="text-2xl font-bold leading-tight mb-1"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)', letterSpacing: '-0.03em' }}
                    >
                        {formatCurrency(detail.amount_paid)}
                    </h2>
                    <p className="text-sm mb-3" style={{ color: 'var(--blanc-ink-2)' }}>
                        Paid by <strong style={{ color: 'var(--blanc-ink-1)' }}>{detail.client}</strong> for <strong style={{ color: 'var(--blanc-ink-1)' }}>#{detail.job_number}</strong>
                    </p>
                    {/* Status pills */}
                    <div className="flex items-center gap-2 flex-wrap">
                        {statusPill(detail.transaction_status)}
                        {detail.invoice && statusPill(detail.invoice.paid_in_full ? 'Paid In Full' : `Due: ${formatCurrency(detail.invoice.amount_due)}`)}
                        {isCheck && (
                            <Popover>
                                <PopoverTrigger asChild>
                                    <button
                                        className="inline-flex items-center px-3 text-xs font-semibold cursor-pointer"
                                        style={{
                                            background: hexToRgba(detail.check_deposited ? '#1B8B63' : '#EF4444', 0.1),
                                            color: detail.check_deposited ? '#1B8B63' : '#EF4444',
                                            minHeight: 28, borderRadius: 8, border: 'none',
                                        }}
                                    >
                                        {detail.check_deposited ? 'Deposited' : 'Not Deposited'}
                                    </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-1" align="start">
                                    <button className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted" onClick={() => onToggleDeposited(true)}>
                                        <span className="size-2 rounded-full" style={{ background: '#1B8B63' }} /> Deposited
                                    </button>
                                    <button className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded text-sm hover:bg-muted" onClick={() => onToggleDeposited(false)}>
                                        <span className="size-2 rounded-full" style={{ background: '#EF4444' }} /> Not Deposited
                                    </button>
                                </PopoverContent>
                            </Popover>
                        )}
                    </div>
                </div>

                {/* Warning */}
                {detail._warning && (
                    <div className="mx-5 mb-3 px-3 py-2 rounded-xl text-[12px]" style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.2)', color: 'var(--blanc-ink-2)' }}>
                        {detail._warning}
                    </div>
                )}

                {/* Tiles */}
                <div className="px-4 py-4 space-y-3">
                    {/* Invoice tile */}
                    {detail.invoice && (
                        <div style={sectionCard}>
                            <p style={eyebrow}>Invoice</p>
                            <div style={infoRow}>
                                <span style={infoLabel}>Total</span>
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{formatCurrency(detail.invoice.total)}</span>
                            </div>
                            <div style={infoRow}>
                                <span style={infoLabel}>Paid</span>
                                <span className="text-[13px] font-semibold" style={{ color: '#1B8B63' }}>{formatCurrency(detail.invoice.amount_paid)}</span>
                            </div>
                            <div style={{ ...infoRow, borderBottom: 'none', paddingBottom: 0 }}>
                                <span style={infoLabel}>Due</span>
                                <span className="text-[13px] font-semibold" style={{ color: parseFloat(detail.invoice.amount_due) > 0 ? '#EF4444' : 'var(--blanc-ink-1)' }}>
                                    {formatCurrency(detail.invoice.amount_due)}
                                </span>
                            </div>
                        </div>
                    )}

                </div>

            </div>

            {/* RIGHT: Job + Providers + Metadata */}
            <div className="w-full md:w-1/2 flex flex-col px-4 py-4 space-y-3">
                {/* Job tile */}
                {detail.job && (
                    <div
                        style={{ ...sectionCard, cursor: detail.local_job_id ? 'pointer' : 'default' }}
                        onClick={() => detail.local_job_id && navigate(`/jobs/${detail.local_job_id}`)}
                        className={detail.local_job_id ? 'transition-opacity hover:opacity-80' : ''}
                    >
                        <p style={eyebrow}>Job</p>
                        <div
                            className="text-[15px] leading-snug font-semibold"
                            style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' }}
                        >
                            {detail.job.job_number && `#${detail.job.job_number}`}
                            {detail.job.service_name && ` · ${detail.job.service_name}`}
                        </div>
                        {detail.job.service_address && (
                            <div className="text-[13px] mt-1" style={{ color: 'var(--blanc-ink-2)' }}>
                                {detail.job.service_address}
                            </div>
                        )}
                    </div>
                )}

                {/* Provider tile */}
                {detail.job && detail.job.providers.length > 0 && (
                    <div style={sectionCard}>
                        <p style={eyebrow}>Providers</p>
                        <div className="flex flex-wrap gap-2">
                            {detail.job.providers.map((p, i) => (
                                <span
                                    key={i}
                                    className="inline-flex items-center gap-1 min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                                    style={{ background: 'rgba(117, 106, 89, 0.07)', border: '1px solid rgba(117, 106, 89, 0.14)', color: 'var(--blanc-ink-1)' }}
                                >
                                    {p.name}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                <MetadataSection metadata={detail.metadata} showMetadata={showMetadata} setShowMetadata={setShowMetadata} />
            </div>

            </div>

            {/* ═══ BOTTOM: Attachments (full width) ═══ */}
            <div className="px-4 pb-4">
                <AttachmentsSection attachments={allAttachments} />
            </div>
        </div>
    );
}

// AttachmentsSection extracted to ../shared/AttachmentsSection.tsx

// ─── Metadata Section ────────────────────────────────────────────────────────

function MetadataSection({ metadata, showMetadata, setShowMetadata }: {
    metadata: Record<string, string | null> | null | undefined;
    showMetadata: boolean;
    setShowMetadata: (v: boolean) => void;
}) {
    if (!metadata || Object.keys(metadata).length === 0) return null;

    return (
        <div>
            <button
                onClick={() => setShowMetadata(!showMetadata)}
                className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest transition-opacity hover:opacity-70"
                style={{ color: 'var(--blanc-ink-3)', letterSpacing: '0.14em', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
                <ChevronDown className="size-3" style={{ transform: showMetadata ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
                Transaction Metadata
            </button>
            {showMetadata && (
                <div className="mt-2 space-y-1">
                    {Object.entries(metadata).map(([key, val]) => val ? (
                        <div key={key} className="flex gap-2 text-[12px]">
                            <span style={{ color: 'var(--blanc-ink-3)', minWidth: 100, textTransform: 'capitalize' as const }}>{key.replace(/_/g, ' ')}</span>
                            <span className="font-mono text-[11px]" style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-all' as const }}>{val}</span>
                        </div>
                    ) : null)}
                </div>
            )}
        </div>
    );
}

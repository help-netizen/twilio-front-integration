/**
 * JobMobileCard — a single Jobs tile for the mobile Jobs list (JOBS-MOBILE-001).
 *
 * Mirrors the Schedule agenda tile (ScheduleItemCard layout='agenda', SCHED-TILE-001)
 * but reads a `LocalJob`. Composition:
 *   time hero (start_date[–end_date]; if no time → service_name is the hero)
 *     → service_name (title) → "customer_name, city" (plain text, one line)
 *   top-right cluster = technician (assigned_techs[0].name +N / "Unassigned") + status dot
 *   left 4px border = provider color · canceled → opacity .6
 *   payment pill (bottom) only when finance-permitted AND invoice_status is present.
 *
 * No job number is shown (per the tile design). Desktop is unaffected — this is
 * rendered only inside JobsMobileList, which JobsPage mounts behind useIsMobile.
 */

import React from 'react';
import type { LocalJob } from '../../services/jobsApi';
import { formatTimeInTZ } from '../../utils/companyTime';
import { getProviderColor } from '../../utils/providerColors';
import { BLANC_STATUS_COLORS } from './jobsFilterHelpers';

const UNASSIGNED_ACCENT = 'var(--blanc-ink-3, rgba(117, 106, 89, 0.6))';
const UNASSIGNED_BG = 'linear-gradient(180deg, rgba(248, 246, 242, 0.98), rgba(240, 237, 232, 0.94))';
const UNASSIGNED_BORDER = 'rgba(117, 106, 89, 0.18)';

// ── Payment pill ────────────────────────────────────────────────────────────
// invoice_status comes from either the local invoices service ('paid' | 'partial'
// | 'sent' | 'viewed' | 'overdue' | 'draft' | 'void') or Zenbooker
// ('paid' | 'partially_paid' | 'unpaid' | …). Collapse to the 3 buckets the spec
// defines: Paid (green) / Partial (amber) / Unpaid (red).
type PayTone = { label: string; bg: string; fg: string };

function paymentTone(invoiceStatus: string): PayTone | null {
    const s = invoiceStatus.toLowerCase();
    if (s === 'paid') return { label: 'Paid', bg: 'rgba(34, 197, 94, 0.14)', fg: '#15803d' };
    if (s === 'partial' || s === 'partially_paid') return { label: 'Partial', bg: 'rgba(245, 158, 11, 0.16)', fg: '#b45309' };
    // Non-payable states carry no useful payment signal on a job tile — hide the pill.
    if (s === 'draft' || s === 'void' || s === 'voided') return null;
    return { label: 'Unpaid', bg: 'rgba(239, 68, 68, 0.14)', fg: '#b91c1c' };
}

function formatMoney(v?: string): string | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface JobMobileCardProps {
    job: LocalJob;
    timezone?: string;
    /** Resolved once by JobsMobileList via useAuthz — gates the payment pill. */
    canViewFinance: boolean;
    onClick: (job: LocalJob) => void;
}

export const JobMobileCard: React.FC<JobMobileCardProps> = ({ job, timezone, canViewFinance, onClick }) => {
    const primaryTech = job.assigned_techs?.[0];
    const provColor = primaryTech ? getProviderColor(primaryTech.id || primaryTech.name) : null;
    const accent = provColor ? provColor.accent : UNASSIGNED_ACCENT;
    const background = provColor ? `linear-gradient(180deg, ${provColor.bg}, ${provColor.bg})` : UNASSIGNED_BG;
    const border = provColor ? provColor.border : UNASSIGNED_BORDER;

    const isCanceled = job.blanc_status === 'Canceled';
    const statusColor = job.blanc_status ? BLANC_STATUS_COLORS[job.blanc_status] : undefined;

    const timeLabel = job.start_date
        ? `${formatTimeInTZ(new Date(job.start_date), timezone)}${job.end_date ? ' - ' + formatTimeInTZ(new Date(job.end_date), timezone) : ''}`
        : '';
    const hasTime = !!timeLabel;

    const techCount = job.assigned_techs?.length || 0;
    const techSummary = techCount > 0
        ? `${job.assigned_techs![0].name}${techCount > 1 ? ` +${techCount - 1}` : ''}`
        : 'Unassigned';

    const title = job.service_name || '';
    const nameCity = [job.customer_name, job.city].filter(Boolean).join(', ');

    // Payment pill — only with finance permission + a real invoice_status.
    const pill = (() => {
        if (!canViewFinance || !job.invoice_status) return null;
        const tone = paymentTone(job.invoice_status);
        if (!tone) return null;
        const money = formatMoney(job.invoice_total);
        return (
            <span
                className="inline-flex items-center self-start rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap"
                style={{ background: tone.bg, color: tone.fg }}
            >
                {tone.label}{money ? ` · ${money}` : ''}
            </span>
        );
    })();

    const statusDot = job.blanc_status ? (
        <span
            className="inline-block rounded-full flex-shrink-0"
            style={{ width: 8, height: 8, background: statusColor || 'var(--blanc-ink-3)' }}
            title={job.blanc_status}
        />
    ) : null;

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onClick(job)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(job); } }}
            className={`
                relative w-full text-left overflow-hidden transition-shadow cursor-pointer
                hover:shadow-xl
                focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 outline-none
                ${isCanceled ? 'opacity-60' : ''}
            `}
            style={{
                background,
                border: `1px solid ${border}`,
                borderLeft: `4px solid ${accent}`,
                borderRadius: '18px',
                boxShadow: 'var(--blanc-shadow-card, 0 6px 16px rgba(48, 39, 28, 0.06))',
            }}
        >
            <div className="p-3.5 pb-3 flex flex-col gap-1" style={{ paddingLeft: '14px' }}>
                {/* Top row: time hero (left) + tech · status dot (right) */}
                <div className="flex items-start justify-between gap-2" style={{ minWidth: 0 }}>
                    {hasTime ? (
                        <span
                            className="font-bold whitespace-nowrap"
                            style={{ fontSize: '16px', color: 'var(--blanc-ink-1)' }}
                        >
                            {timeLabel}
                        </span>
                    ) : (
                        <h3
                            className="font-semibold truncate"
                            style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', fontSize: '16px', color: 'var(--blanc-ink-1)', margin: 0, minWidth: 0 }}
                        >
                            {title || 'Job'}
                        </h3>
                    )}
                    <span className="flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
                        <span className="text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>{techSummary}</span>
                        {statusDot}
                    </span>
                </div>

                {/* Title — omitted when it became the hero (no time) */}
                {hasTime && title && (
                    <h3
                        className="truncate"
                        style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', fontSize: '14px', fontWeight: 500, color: 'var(--blanc-ink-1)', margin: 0 }}
                    >
                        {title}
                    </h3>
                )}

                {/* Customer · City — plain text, one line */}
                {nameCity && (
                    <span className="truncate" style={{ fontSize: '14px', fontWeight: 400, color: 'var(--blanc-ink-2)' }}>
                        {nameCity}
                    </span>
                )}

                {/* Payment pill */}
                {pill}
            </div>
        </div>
    );
};

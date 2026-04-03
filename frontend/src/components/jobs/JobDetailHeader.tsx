import { ExternalLink, ChevronDown } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { BLANC_STATUSES, BLANC_STATUS_COLORS } from './jobHelpers';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobDetailHeaderProps {
    job: LocalJob;
    contactInfo: { id: number; name: string; phone?: string; email?: string } | null;
    navigate: (path: string) => void;
    onBlancStatusChange: (id: number, s: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobDetailHeader({ job, contactInfo, navigate, onBlancStatusChange }: JobDetailHeaderProps) {
    const customerName = contactInfo?.name || job.customer_name;
    const showServiceInEyebrow = !!job.service_name && !!customerName;
    const mainTitle = customerName || job.service_name || 'Job';

    const statusColor = BLANC_STATUS_COLORS[job.blanc_status] || '#9CA3AF';
    const statusBg = hexToRgba(statusColor, 0.1);

    return (
        <div className="px-5 pt-5 pb-3">
            {/* Eyebrow: JOB · #629656 · Dryer */}
            <div className="mb-2">
                <span
                    className="text-[10px] font-semibold uppercase tracking-widest inline-flex items-center gap-1.5"
                    style={{ color: 'var(--blanc-info)', letterSpacing: '0.12em' }}
                >
                    Job
                    {(job.job_number || job.id) && (
                        <>
                            <span style={{ opacity: 0.4 }}>·</span>
                            {job.zenbooker_job_id ? (
                                <a
                                    href={`https://zenbooker.com/app?view=jobs&view-job=${job.zenbooker_job_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 font-mono transition-opacity hover:opacity-70"
                                    onClick={e => e.stopPropagation()}
                                >
                                    #{job.job_number || job.id}
                                    <ExternalLink className="size-2.5" />
                                </a>
                            ) : (
                                <span className="font-mono">#{job.job_number || job.id}</span>
                            )}
                        </>
                    )}
                    {showServiceInEyebrow && (
                        <>
                            <span style={{ opacity: 0.4 }}>·</span>
                            <span style={{
                                color: 'var(--blanc-ink-3)',
                                fontWeight: 500,
                                textTransform: 'none',
                                letterSpacing: 'normal',
                                fontSize: 11,
                            }}>
                                {job.service_name}
                            </span>
                        </>
                    )}
                </span>
            </div>

            {/* Customer name — large heading */}
            <h2
                className="text-2xl font-bold leading-tight mb-3"
                style={{
                    fontFamily: 'var(--blanc-font-heading)',
                    color: 'var(--blanc-ink-1)',
                    letterSpacing: '-0.03em',
                }}
            >
                {contactInfo ? (
                    <button
                        onClick={() => navigate(`/contacts/${contactInfo.id}`)}
                        className="hover:opacity-70 transition-opacity text-left"
                    >
                        {mainTitle}
                    </button>
                ) : (
                    mainTitle
                )}
            </h2>

            {/* Status pill + source — same row, Lead card style */}
            <div className="flex items-center gap-2 flex-wrap">
                {/* Blanc status — large pill dropdown */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1.5 px-4 text-sm font-semibold transition-colors focus:outline-none"
                            style={{
                                background: statusBg,
                                color: statusColor,
                                minHeight: 42,
                                borderRadius: 14,
                                border: 'none',
                            }}
                        >
                            {job.blanc_status}
                            <ChevronDown className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {BLANC_STATUSES.map(s => (
                            <DropdownMenuItem key={s} onClick={() => onBlancStatusChange(job.id, s)}
                                className={s === job.blanc_status ? 'bg-accent' : ''}>
                                {s}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>

                {/* Source — static pill, same height */}
                {job.job_source && (
                    <span
                        className="inline-flex items-center px-4 text-sm font-medium"
                        style={{
                            background: 'rgba(117,106,89,0.08)',
                            color: 'var(--blanc-ink-2)',
                            border: '1px solid var(--blanc-line)',
                            minHeight: 42,
                            borderRadius: 14,
                        }}
                    >
                        {job.job_source}
                    </span>
                )}
            </div>
        </div>
    );
}

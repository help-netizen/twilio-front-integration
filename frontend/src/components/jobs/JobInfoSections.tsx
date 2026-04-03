import { useState } from 'react';
import { CalendarClock, Loader2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import type { LocalJob } from '../../services/jobsApi';
import { rescheduleJob } from '../../services/jobsApi';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { useNavigate } from 'react-router-dom';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobInfoSectionsProps {
    job: LocalJob;
    contactInfo: { id: number; name: string; phone?: string; email?: string } | null;
    onJobUpdated?: (updatedJob: LocalJob) => void;
}

// ─── Shared tile styles (mirrors ScheduleSidebar) ────────────────────────────

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

// ─── Component ───────────────────────────────────────────────────────────────

export function JobInfoSections({ job, contactInfo, onJobUpdated }: JobInfoSectionsProps) {
    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduling, setRescheduling] = useState(false);
    const navigate = useNavigate();

    const territoryId = job.zb_raw?.territory?.id || job.zb_raw?.service_territory?.id || undefined;

    const handleRescheduleConfirm = async (slot: { type: 'arrival_window'; start: string; end: string; formatted: string; techId?: string }) => {
        setShowReschedule(false);
        setRescheduling(true);
        try {
            const arrivalMinutes = Math.round((new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60000);
            const updated = await rescheduleJob(job.id, {
                start_date: slot.start,
                arrival_window_minutes: arrivalMinutes,
                tech_id: slot.techId,
            });
            toast.success('Job rescheduled', { description: slot.formatted });
            onJobUpdated?.(updated);
        } catch (err) {
            toast.error('Failed to reschedule', { description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setRescheduling(false);
        }
    };

    const canReschedule = !job.zb_canceled && job.zb_status !== 'complete';
    const phone = contactInfo?.phone || job.customer_phone;
    const email = contactInfo?.email || job.customer_email;
    const customerName = contactInfo?.name || job.customer_name;

    return (
        <div className="px-4 py-4 space-y-3">

            {/* ── SCHEDULED + LOCATION + PROVIDERS (one card) ── */}
            {(job.start_date || job.address || job.territory || (job.assigned_techs && job.assigned_techs.length > 0)) && (
                <div style={sectionCard}>

                    {/* Schedule */}
                    {job.start_date && (
                        <div style={{ paddingBottom: (job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0) ? 14 : 0, marginBottom: (job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0) ? 14 : 0, borderBottom: (job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0) ? '1px dashed rgba(117,106,89,0.16)' : undefined }}>
                            <div className="flex items-center justify-between mb-2">
                                <p style={{ ...eyebrow, marginBottom: 0 }}>Scheduled</p>
                                {canReschedule && (
                                    <button
                                        onClick={() => setShowReschedule(true)}
                                        disabled={rescheduling}
                                        className="inline-flex items-center gap-1 text-[11px] font-medium transition-opacity hover:opacity-70 disabled:opacity-40"
                                        style={{ color: 'var(--blanc-ink-3)' }}
                                    >
                                        {rescheduling ? <Loader2 className="size-3 animate-spin" /> : <CalendarClock className="size-3" />}
                                        Reschedule
                                    </button>
                                )}
                            </div>
                            <div
                                className="text-lg leading-tight font-semibold"
                                style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.03em', color: 'var(--blanc-ink-1)' }}
                            >
                                {new Date(job.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                {', '}
                                {new Date(job.start_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                {job.end_date && (
                                    <span style={{ color: 'var(--blanc-ink-2)' }}>
                                        {' – '}
                                        {new Date(job.end_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Location */}
                    {(job.address || job.territory) && (
                        <div style={{ paddingBottom: (job.assigned_techs?.length ?? 0) > 0 ? 14 : 0, marginBottom: (job.assigned_techs?.length ?? 0) > 0 ? 14 : 0, borderBottom: (job.assigned_techs?.length ?? 0) > 0 ? '1px dashed rgba(117,106,89,0.16)' : undefined }}>
                            <div className="flex items-center gap-1.5 mb-1">
                                <p style={{ ...eyebrow, marginBottom: 0 }}>Location</p>
                                {job.territory && (
                                    <span className="text-[11px] font-medium" style={{ color: 'var(--blanc-ink-3)' }}>· {job.territory}</span>
                                )}
                            </div>
                            {job.address && (
                                <div
                                    className="text-[15px] leading-snug font-semibold"
                                    style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' }}
                                >
                                    {job.address}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Providers */}
                    {job.assigned_techs && job.assigned_techs.length > 0 && (
                        <div>
                            <p style={{ ...eyebrow, marginBottom: 8 }}>Providers</p>
                            <div className="flex flex-wrap gap-2">
                                {job.assigned_techs.map((t: any) => (
                                    <span
                                        key={t.id}
                                        className="inline-flex items-center gap-1 min-h-[34px] px-3.5 rounded-full text-[13px] font-medium"
                                        style={{
                                            background: 'rgba(117, 106, 89, 0.07)',
                                            border: '1px solid rgba(117, 106, 89, 0.14)',
                                            color: 'var(--blanc-ink-1)',
                                        }}
                                    >
                                        {t.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── CONTACT ── */}
            {(customerName || phone || email) && (
                <div style={sectionCard}>
                    <p style={eyebrow}>Contact</p>
                    {customerName && (
                        <div style={infoRow}>
                            <span style={infoLabel}>Customer</span>
                            {(contactInfo?.id || job.contact_id) ? (
                                <button
                                    type="button"
                                    onClick={() => navigate(`/contacts/${contactInfo?.id ?? job.contact_id}`)}
                                    className="flex items-center gap-1 text-[13px] font-semibold hover:underline"
                                    style={{ color: 'var(--blanc-info)', background: 'none', border: 'none', cursor: 'pointer' }}
                                >
                                    {customerName}
                                    <ChevronRight className="size-3 flex-shrink-0" />
                                </button>
                            ) : (
                                <span className="text-[13px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{customerName}</span>
                            )}
                        </div>
                    )}
                    {phone && (
                        <div style={infoRow}>
                            <span style={infoLabel}>Phone</span>
                            <div className="flex items-center gap-2">
                                <a href={`tel:${phone}`} className="text-[13px] font-semibold hover:underline" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {formatPhone(phone)}
                                </a>
                                <ClickToCallButton phone={phone} contactName={customerName || undefined} />
                                <OpenTimelineButton phone={phone} contactId={contactInfo?.id} />
                            </div>
                        </div>
                    )}
                    {email && (
                        <div style={{ ...infoRow, borderBottom: 'none', paddingBottom: 0 }}>
                            <span style={infoLabel}>Email</span>
                            <a
                                href={`mailto:${email}`}
                                className="text-[13px] font-semibold hover:underline"
                                style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-all' }}
                            >
                                {email}
                            </a>
                        </div>
                    )}
                </div>
            )}

            <CustomTimeModal
                open={showReschedule}
                onClose={() => setShowReschedule(false)}
                onConfirm={handleRescheduleConfirm}
                newJobCoords={job.lat && job.lng ? { lat: job.lat, lng: job.lng } : null}
                newJobAddress={job.address}
                newJobDuration={120}
                territoryId={territoryId}
                excludeJobId={job.id}
                initialSlot={job.start_date && job.end_date && job.assigned_techs?.[0]?.id ? {
                    techId: job.assigned_techs[0].id,
                    start: job.start_date,
                    end: job.end_date,
                } : undefined}
            />
        </div>
    );
}

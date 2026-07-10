import { useState } from 'react';
import { CalendarClock, Loader2, ChevronRight, Pencil, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type { LocalJob } from '../../services/jobsApi';
import { rescheduleJob, updateJobLocation } from '../../services/jobsApi';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { EMPTY_ADDRESS, type AddressFields } from '../addressAutoHelpers';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { JobTechnicianControl } from './JobTechnicianControl';
import { useNavigate } from 'react-router-dom';
import { googleMapsUrl } from '../../utils/routeFormat';

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
    border: '1px solid var(--blanc-line)',
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
    borderBottom: '1px dashed rgba(25, 25, 25, 0.12)',
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
    const [editingAddress, setEditingAddress] = useState(false);
    const [savingAddress, setSavingAddress] = useState(false);
    const [addrDraft, setAddrDraft] = useState<AddressFields>(EMPTY_ADDRESS);
    const navigate = useNavigate();

    const beginEditAddress = () => {
        setAddrDraft({ ...EMPTY_ADDRESS, street: job.address || '', lat: job.lat ?? null, lng: job.lng ?? null });
        setEditingAddress(true);
    };

    const saveAddress = async () => {
        const street = [addrDraft.street, addrDraft.apt].filter(Boolean).join(' ');
        const composed = [street, addrDraft.city, addrDraft.state, addrDraft.zip].filter(Boolean).join(', ');
        if (!composed.trim()) { setEditingAddress(false); return; }
        setSavingAddress(true);
        try {
            const updated = await updateJobLocation(job.id, {
                address: composed,
                lat: addrDraft.lat ?? null,
                lng: addrDraft.lng ?? null,
                normalized_address: composed,
            });
            toast.success('Address updated', { description: 'Route is recalculating' });
            onJobUpdated?.(updated);
            setEditingAddress(false);
        } catch (err) {
            toast.error('Failed to update address', { description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setSavingAddress(false);
        }
    };

    const territoryId = job.zb_raw?.territory?.id || job.zb_raw?.service_territory?.id || undefined;

    const handleRescheduleConfirm = async (slot: { type: 'arrival_window'; start: string; end: string; formatted: string; techId?: string }) => {
        setShowReschedule(false);
        setRescheduling(true);
        try {
            const arrivalMinutes = Math.round((new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60000);
            // OUTBOUND-PARTS-CALL-TECHSLOT-001 (req 3) — a job with 2+ assigned
            // technicians reschedules TIME-ONLY: omit tech_id so the backend's
            // `if (tech_id)` reassign block (jobs.js reschedule) never runs and BOTH
            // techs stay assigned. Single/zero-tech jobs keep JOB-TECH-ASSIGN-001
            // behavior — picking another tech's lane still reassigns.
            const multiTech = (job.assigned_techs || []).length >= 2;
            const updated = await rescheduleJob(job.id, {
                start_date: slot.start,
                arrival_window_minutes: arrivalMinutes,
                ...(multiTech ? {} : { tech_id: slot.techId }),
            });
            toast.success('Job rescheduled', { description: slot.formatted });
            onJobUpdated?.(updated);
        } catch (err) {
            toast.error('Failed to reschedule', { description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setRescheduling(false);
        }
    };

    // Reschedule is always available when a schedule exists — Zenbooker's reschedule
    // endpoint accepts calls regardless of ZB status (complete/canceled), and Albusto may
    // legitimately be in an open operational state while ZB is still terminal
    // (operator-reopen scenario, see jobsService.js syncFromZenbooker override).
    const canReschedule = !!job.start_date;
    const phone = contactInfo?.phone || job.customer_phone;
    const email = contactInfo?.email || job.customer_email;
    const customerName = contactInfo?.name || job.customer_name;

    return (
        <div className="px-4 py-4 space-y-3">

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

            {/* ── SCHEDULED + LOCATION + PROVIDERS (one card) ── */}
            {(job.start_date || job.address || job.territory || (job.assigned_techs && job.assigned_techs.length > 0)) && (
                <div style={sectionCard}>

                    {/* Schedule */}
                    {job.start_date && (
                        <div style={{ paddingBottom: (job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0) ? 14 : 0, marginBottom: (job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0) ? 14 : 0, borderBottom: (job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0) ? '1px dashed rgba(25,25,25,0.12)' : undefined }}>
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

                    {/* Location — SCHED-ROUTE-001 FR-002/FR-003: clickable Maps link + inline edit */}
                    <div style={{ paddingBottom: (job.assigned_techs?.length ?? 0) > 0 ? 14 : 0, marginBottom: (job.assigned_techs?.length ?? 0) > 0 ? 14 : 0, borderBottom: (job.assigned_techs?.length ?? 0) > 0 ? '1px dashed rgba(25,25,25,0.12)' : undefined }}>
                        <div className="flex items-center gap-1.5 mb-1">
                            <p style={{ ...eyebrow, marginBottom: 0 }}>Location</p>
                            {job.territory && (
                                <span className="text-[11px] font-medium" style={{ color: 'var(--blanc-ink-3)' }}>· {job.territory}</span>
                            )}
                            {!editingAddress && (
                                <button
                                    type="button"
                                    onClick={beginEditAddress}
                                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium hover:opacity-100 opacity-70"
                                    style={{ color: 'var(--blanc-ink-3)' }}
                                    title="Edit address"
                                >
                                    <Pencil className="size-3" /> {job.address ? 'Edit' : 'Add address'}
                                </button>
                            )}
                        </div>

                        {editingAddress ? (
                            <div className="space-y-2">
                                <AddressAutocomplete
                                    idPrefix="job-addr"
                                    defaultUseDetails
                                    value={addrDraft}
                                    onChange={setAddrDraft}
                                />
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        disabled={savingAddress}
                                        onClick={saveAddress}
                                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-bold text-white disabled:opacity-60"
                                        style={{ background: 'var(--blanc-ink-1)' }}
                                    >
                                        {savingAddress ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
                                    </button>
                                    <button
                                        type="button"
                                        disabled={savingAddress}
                                        onClick={() => setEditingAddress(false)}
                                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium"
                                        style={{ color: 'var(--blanc-ink-2)' }}
                                    >
                                        <X className="size-3.5" /> Cancel
                                    </button>
                                </div>
                            </div>
                        ) : job.address ? (() => {
                            // FR-003: clickable Maps link (prefers stored coords; generated, no Google call).
                            const mapsUrl = googleMapsUrl({ lat: job.lat, lng: job.lng, address: job.address });
                            const cls = 'text-[15px] leading-snug font-semibold';
                            const sty = { fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' } as const;
                            return mapsUrl ? (
                                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={`${cls} hover:underline`} style={sty}>
                                    {job.address}
                                </a>
                            ) : (
                                <div className={cls} style={sty}>{job.address}</div>
                            );
                        })() : (
                            <p className="text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>No address</p>
                        )}
                    </div>

                    {/* Technician — assign / change / unassign WITHOUT rescheduling (JOB-TECH-ASSIGN-001) */}
                    <JobTechnicianControl job={job} onJobUpdated={onJobUpdated} />
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
                // OUTBOUND-PARTS-CALL-TECHSLOT-001 (req 3) — reschedule recommendations
                // default to the job's CURRENT tech: first of a stable by-id sort
                // (deterministic for 2+ tech jobs). No assigned techs → undefined
                // (legacy all-tech recs). The timelines still show ALL techs so the
                // dispatcher can override; the submit path above is unchanged.
                recommendTechId={[...(job.assigned_techs || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0]?.id}
                initialSlot={job.start_date && job.end_date && job.assigned_techs?.[0]?.id ? {
                    techId: job.assigned_techs[0].id,
                    start: job.start_date,
                    end: job.end_date,
                } : undefined}
            />
        </div>
    );
}

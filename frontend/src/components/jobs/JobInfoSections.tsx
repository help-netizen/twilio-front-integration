import { useState } from 'react';
import { CalendarClock, Loader2, ChevronRight, Pencil, Check, X, User, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import type { LocalJob } from '../../services/jobsApi';
import { rescheduleJob, updateJobLocation } from '../../services/jobsApi';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { EMPTY_ADDRESS, type AddressFields } from '../addressAutoHelpers';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { MaskedCallLine } from '../shared/MaskedCallLine';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { fetchUnavailability, overlapsUnavailability, unavailabilityWarningPhrase } from '../../services/scheduleApi';
import { getCompanyTimezone, formatUnavailabilityPeriod } from './timeOffWarning';
import { JobTechnicianControl } from './JobTechnicianControl';
import { useNavigate } from 'react-router-dom';
import { googleMapsUrl } from '../../utils/routeFormat';
import { LEVEL_TWO_QUIET, LEVEL_TWO_HEADING, LEVEL_TWO_LABEL_WIDTH } from '../../styles/levelTwo';
import { useCompanyTime } from '../../lib/companyTime';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobInfoSectionsProps {
    job: LocalJob;
    contactInfo: { id: number; name: string; phone?: string; email?: string; secondary_phone?: string; secondary_phone_name?: string } | null;
    onJobUpdated?: (updatedJob: LocalJob) => void;
    /** 'flat' drops the card frame — same sections, no chrome (payment card). */
    variant?: 'card' | 'flat';
}

// The slot shape CustomTimeModal confirms with (unchanged — named here so the
// TECH-DAYOFF-001 pending-confirm state can hold it).
type RescheduleSlot = { type: 'arrival_window'; start: string; end: string; formatted: string; techId?: string };

// ─── Shared tile styles (mirrors ScheduleSidebar) ────────────────────────────

const sectionCard: React.CSSProperties = {
    padding: '16px 16px 18px',
    borderRadius: '20px',
    border: '1px solid var(--blanc-line)',
    background: 'rgba(255, 255, 255, 0.5)',
};

// The payment card shows these very sections and asks for them flat: no frame,
// separated by space alone. Same behaviour — masking, call/text, reschedule —
// only without the chrome, so neither surface has to reimplement any of it.
const flatSection: React.CSSProperties = {
    padding: '0 0 4px',
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

// Flat rows carry no dashed rule between them: on the level-two rule the grey
// label already marks where one field ends and the next begins, and a dotted
// line across a phone-width column is noise pretending to be structure.
const flatRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '3px 0',
};

const flatLabel: React.CSSProperties = {
    ...LEVEL_TWO_QUIET,
    flexShrink: 0,
    width: `${LEVEL_TWO_LABEL_WIDTH}px`,
};

// ─── Component ───────────────────────────────────────────────────────────────

export function JobInfoSections({ job, contactInfo, onJobUpdated, variant = 'card' }: JobInfoSectionsProps) {
    const { format } = useCompanyTime();
    const section = variant === 'flat' ? flatSection : sectionCard;
    const flat = variant === 'flat';
    // Flat runs the level-two rule: the group's heading is the SAME size as the
    // rows under it and is made a heading by weight and colour alone — black
    // and bold against the grey labels it introduces. Eleven sizes were doing
    // the work those two do better.
    const label: React.CSSProperties = flat
        ? { ...LEVEL_TWO_HEADING, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '7px' }
        : eyebrow;
    const row: React.CSSProperties = flat ? flatRow : infoRow;
    const rowLabel: React.CSSProperties = flat ? flatLabel : infoLabel;
    // Values differ from their labels by colour alone, so the class carries no
    // size or weight of its own. The card variant keeps what it always had.
    const value = flat ? 'blanc-l2' : 'text-[13px] font-semibold';
    // The icon belongs to the heading, so it takes the heading's colour — a
    // grey mark in front of black bold text reads as two separate things.
    const icon = flat
        ? { size: 15, style: { color: 'var(--blanc-ink-1)', flexShrink: 0 } as React.CSSProperties }
        : null;
    // Groups inside one card: dashed rules on the job card, plain space on the
    // flat one — flat has no frame to divide, so a line would be the only edge
    // on the page and would read as a mistake.
    const groupGap = (hasNext: boolean): React.CSSProperties => {
        if (!hasNext) return {};
        return flat
            ? { marginBottom: 18 }
            : { paddingBottom: 14, marginBottom: 14, borderBottom: '1px dashed rgba(25,25,25,0.12)' };
    };
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

    // Warning-only: after the time is picked and BEFORE the existing reschedule
    // call, run a targeted effective-unavailability check for each of
    // the job's CURRENT assigned techs on the chosen interval. A conflict opens
    // a confirm modal (center dialog canon); confirming runs the untouched
    // reschedule path. A failed verification asks for confirmation too.
    const [pendingReschedule, setPendingReschedule] = useState<{ message: string; slot: RescheduleSlot } | null>(null);

    const handleRescheduleConfirm = async (slot: RescheduleSlot) => {
        setShowReschedule(false);
        const techs = job.assigned_techs || [];
        if (techs.length > 0) {
            try {
                const [perTech, tz] = await Promise.all([
                    Promise.all(techs.map(t => fetchUnavailability({ from: slot.start, to: slot.end, technician_id: t.id }))),
                    getCompanyTimezone(),
                ]);
                const conflicts = overlapsUnavailability(perTech.flat(), techs.map(t => t.id), slot.start, slot.end);
                if (conflicts.length > 0) {
                    const c = conflicts[0];
                    setPendingReschedule({
                        message: `${c.technician_name} ${unavailabilityWarningPhrase(c)} ${formatUnavailabilityPeriod(c, tz)}.`,
                        slot,
                    });
                    return;
                }
            } catch (err) {
                console.warn('[JobInfoSections] availability warning check failed', err);
                setPendingReschedule({ message: 'Technician availability could not be verified.', slot });
                return;
            }
        }
        await performReschedule(slot);
    };

    // The pre-existing reschedule path, byte-for-byte — runs either directly
    // (no day-off conflict) or after the dispatcher confirms in the modal.
    const performReschedule = async (slot: RescheduleSlot) => {
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
    // The contact's second number + its label — the job card shows EVERY phone,
    // exactly like the contact card (a second number was silently invisible here).
    const secondaryPhone = contactInfo?.secondary_phone || '';
    const secondaryPhoneName = contactInfo?.secondary_phone_name || '';
    const email = contactInfo?.email || job.customer_email;
    const customerName = contactInfo?.name || job.customer_name;

    return (
        <div className={flat ? 'space-y-5' : 'px-4 py-4 space-y-3'}>

            {/* ── CONTACT ── */}
            {(customerName || phone || secondaryPhone || email) && (
                <div style={section}>
                    <p style={label}>{icon && <User size={icon.size} style={icon.style} />}Contact</p>
                    {customerName && (
                        <div style={row}>
                            <span style={rowLabel}>Customer</span>
                            {(contactInfo?.id || job.contact_id) ? (
                                <button
                                    type="button"
                                    onClick={() => navigate(`/contacts/${contactInfo?.id ?? job.contact_id}`)}
                                    className={`flex items-center gap-1 hover:underline ${value}`}
                                    style={{ color: flat ? 'var(--blanc-ink-1)' : 'var(--blanc-info)', background: 'none', border: 'none', cursor: 'pointer' }}
                                >
                                    {customerName}
                                    <ChevronRight className="size-3 flex-shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                </button>
                            ) : (
                                <span className={value} style={{ color: 'var(--blanc-ink-1)' }}>{customerName}</span>
                            )}
                        </div>
                    )}
                    {phone && (
                        <div style={row}>
                            <span style={rowLabel}>Phone</span>
                            {/* Masking replaces the number AND the call action — a masked
                                call is the only dial a masked viewer gets. Messaging is not a
                                masking concern (Pulse redacts on its own and sends to an opaque
                                target), so Text lives OUTSIDE the wrapper: it used to be
                                swallowed together with the number, leaving field techs with no
                                way to text the customer from the job. */}
                            <div className="flex items-center gap-2">
                                <MaskedCallLine entityType="job" entityId={job.id} maskedLabel="Call">
                                    <div className="flex items-center gap-2">
                                        <a href={`tel:${phone}`} className={`hover:underline ${value}`} style={{ color: 'var(--blanc-ink-1)' }}>
                                            {formatPhone(phone)}
                                        </a>
                                        <ClickToCallButton phone={phone} contactName={customerName || undefined} />
                                    </div>
                                </MaskedCallLine>
                                <OpenTimelineButton
                                    phone={phone}
                                    contactId={contactInfo?.id}
                                    contactName={customerName || undefined}
                                />
                            </div>
                        </div>
                    )}
                    {secondaryPhone && (
                        <div style={row}>
                            {/* The label sits OUTSIDE the masking wrapper on purpose: masking
                                collapses both numbers to ONE masked dial, so the stored label
                                ("Wife", "Office"…) is the only way a masked viewer tells the
                                rows apart — mirrors ContactInfoSections exactly. */}
                            <span style={rowLabel}>{secondaryPhoneName || 'Phone 2'}</span>
                            <div className="flex items-center gap-2">
                                <MaskedCallLine entityType="job" entityId={job.id} maskedLabel="Call">
                                    <div className="flex items-center gap-2">
                                        <a href={`tel:${secondaryPhone}`} className={`hover:underline ${value}`} style={{ color: 'var(--blanc-ink-1)' }}>
                                            {formatPhone(secondaryPhone)}
                                        </a>
                                        <ClickToCallButton phone={secondaryPhone} contactName={customerName || undefined} />
                                    </div>
                                </MaskedCallLine>
                                <OpenTimelineButton
                                    phone={secondaryPhone}
                                    contactId={contactInfo?.id}
                                    contactName={customerName || undefined}
                                />
                            </div>
                        </div>
                    )}
                    {email && (
                        <div style={{ ...row, borderBottom: 'none', paddingBottom: flat ? 3 : 0 }}>
                            <span style={rowLabel}>Email</span>
                            <a
                                href={`mailto:${email}`}
                                className={`hover:underline ${value}`}
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
                <div style={section}>

                    {/* Schedule */}
                    {job.start_date && (
                        <div style={groupGap(!!(job.address || job.territory || (job.assigned_techs?.length ?? 0) > 0))}>
                            <div className={`flex items-center justify-between ${flat ? 'mb-0.5' : 'mb-2'}`}>
                                <p style={{ ...label, marginBottom: 0 }}>{icon && <CalendarClock size={icon.size} style={icon.style} />}Schedule</p>
                                {canReschedule && (
                                    <button
                                        onClick={() => setShowReschedule(true)}
                                        disabled={rescheduling}
                                        className={`inline-flex items-center gap-1 transition-opacity hover:opacity-70 disabled:opacity-40 ${flat ? 'blanc-l2' : 'text-[11px] font-medium'}`}
                                        style={{ color: 'var(--blanc-ink-3)' }}
                                    >
                                        {rescheduling ? <Loader2 className="size-3 animate-spin" /> : <CalendarClock className="size-3" />}
                                        Reschedule
                                    </button>
                                )}
                            </div>
                            <div
                                className={flat ? value : 'text-lg leading-tight font-semibold'}
                                style={flat
                                    ? { color: 'var(--blanc-ink-1)' }
                                    : { fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.03em', color: 'var(--blanc-ink-1)' }}
                            >
                                {format(job.start_date, { month: 'short', day: 'numeric', year: 'numeric' })}
                                {', '}
                                {format(job.start_date, { hour: 'numeric', minute: '2-digit', hour12: true })}
                                {job.end_date && (
                                    <span style={{ color: flat ? 'var(--blanc-ink-3)' : 'var(--blanc-ink-2)' }}>
                                        {' – '}
                                        {format(job.end_date, { hour: 'numeric', minute: '2-digit', hour12: true })}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Location — SCHED-ROUTE-001 FR-002/FR-003: clickable Maps link + inline edit */}
                    <div style={groupGap((job.assigned_techs?.length ?? 0) > 0)}>
                        <div className={`flex items-center gap-1.5 ${flat ? 'mb-0.5' : 'mb-1'}`}>
                            <p style={{ ...label, marginBottom: 0 }}>{icon && <MapPin size={icon.size} style={icon.style} />}Location</p>
                            {job.territory && (
                                <span className={flat ? 'blanc-l2' : 'text-[11px] font-medium'} style={{ color: 'var(--blanc-ink-3)' }}>· {job.territory}</span>
                            )}
                            {!editingAddress && (
                                <button
                                    type="button"
                                    onClick={beginEditAddress}
                                    className={`ml-auto inline-flex items-center gap-1 hover:opacity-100 opacity-70 ${flat ? 'blanc-l2' : 'text-[11px] font-medium'}`}
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
                            const cls = flat ? value : 'text-[15px] leading-snug font-semibold';
                            const sty = flat
                                ? { color: 'var(--blanc-ink-1)' } as const
                                : { fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' } as const;
                            return mapsUrl ? (
                                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={`${cls} hover:underline`} style={sty}>
                                    {job.address}
                                </a>
                            ) : (
                                <div className={cls} style={sty}>{job.address}</div>
                            );
                        })() : (
                            <p className={flat ? 'blanc-l2' : 'text-[13px]'} style={{ color: 'var(--blanc-ink-3)' }}>No address</p>
                        )}
                    </div>

                    {/* Technician — assign / change / unassign WITHOUT rescheduling (JOB-TECH-ASSIGN-001) */}
                    <JobTechnicianControl job={job} onJobUpdated={onJobUpdated} variant={variant} />
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

            {/* TECH-DAYOFF-001 S-13: reschedule-onto-time-off confirmation — center
                modal (canon for short confirmations). Cancel = nothing mutates;
                Reschedule = the untouched reschedule path proceeds. */}
            <Dialog open={!!pendingReschedule} onOpenChange={v => { if (!v) setPendingReschedule(null); }}>
                <DialogContent variant="dialog" size="sm">
                    <DialogHeader>
                        <DialogTitle>Blocked by time off</DialogTitle>
                        <DialogDescription>
                            {pendingReschedule && `${pendingReschedule.message} Reschedule anyway?`}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setPendingReschedule(null)}>Cancel</Button>
                        <Button onClick={() => {
                            const p = pendingReschedule;
                            setPendingReschedule(null);
                            if (p) void performReschedule(p.slot);
                        }}>Reschedule</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

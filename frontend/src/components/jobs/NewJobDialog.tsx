/**
 * NewJobDialog — create a Job directly (no lead, no wizard steps).
 *
 * One screen, four blocks: Contact · Address · Time & technician · Work.
 * The chosen Zenbooker slot (via CustomTimeModal) gives BOTH the arrival window
 * AND the technician (techId) in a single pick. Minimal fields only — no price,
 * duration, territory, or other internal fields.
 */
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, X, Clock, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { JOB_SOURCES } from '../leads/CreateLeadDialog';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { EMPTY_ADDRESS, type AddressFields } from '../addressAutoHelpers';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { useZipCheck } from '../../hooks/useZipCheck';
import * as contactsApi from '../../services/contactsApi';
import { createJob, type CreateJobBody } from '../../services/jobsApi';
import type { CopyJobData } from './copyJobData';
import type { DedupeCandidate } from '../../types/contact';
import '../leads/CreateLeadDialog.css';

interface NewJobDialogProps {
    open: boolean;
    onClose: () => void;
    /**
     * When set, the dialog opens pre-filled from an existing job ("Copy job"):
     * contact (linked), address, job type and description are copied; the
     * technician is pre-selected (preferred) but the timeslot stays empty so the
     * user re-picks the time. Null/undefined = a normal blank "New job".
     */
    copyFrom?: CopyJobData | null;
    /**
     * Pre-set timeslot + technician when opened from a calendar slot ("create from
     * slot"). It's the SAME full New Job form — the slot/tech is just pre-filled and
     * stays editable via the time picker.
     */
    presetSlot?: { start: string; end: string; techId?: string; formatted?: string } | null;
}

interface ChosenSlot {
    start: string;
    end: string;
    techId?: string;
    formatted: string;
}

function composeAddress(a: AddressFields): string {
    const street = [a.street, a.apt].filter(Boolean).join(' ');
    return [street, a.city, a.state, a.zip].filter(Boolean).join(', ');
}


export function NewJobDialog({ open, onClose, copyFrom, presetSlot }: NewJobDialogProps) {
    const navigate = useNavigate();

    // Shared lead/job form config: job types (dynamic) + Additional-info custom fields.
    const { jobTypes: dynamicJobTypes, customFields } = useLeadFormSettings(open);
    const jobTypes = dynamicJobTypes.length > 0 ? dynamicJobTypes : ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];

    // ── Contact ──
    const [contactQuery, setContactQuery] = useState('');
    const [candidates, setCandidates] = useState<DedupeCandidate[]>([]);
    const [searching, setSearching] = useState(false);
    const [selectedContact, setSelectedContact] = useState<{ id: number; name: string } | null>(null);
    const [newName, setNewName] = useState('');
    const [newPhone, setNewPhone] = useState('');
    const [newEmail, setNewEmail] = useState('');

    // ── Address ──
    const [address, setAddress] = useState<AddressFields>(EMPTY_ADDRESS);
    const { territoryResult, coords } = useZipCheck(address.zip);
    const territoryId = territoryResult?.service_territory?.id;

    // ── Time & technician ──
    const [timeOpen, setTimeOpen] = useState(false);
    const [slot, setSlot] = useState<ChosenSlot | null>(null);
    // Preferred technician carried over from a copied job — used to highlight the
    // suggested lane in the time picker. The SLOT itself stays empty (re-pick time).
    const [preferredTechId, setPreferredTechId] = useState<string | undefined>(undefined);

    // ── Work ──
    const [jobType, setJobType] = useState('');
    const [jobSource, setJobSource] = useState('');
    const [metadata, setMetadata] = useState<Record<string, string>>({});
    const [description, setDescription] = useState('');
    const updateMetadata = (apiName: string, value: string) => setMetadata(prev => ({ ...prev, [apiName]: value }));

    const [submitting, setSubmitting] = useState(false);

    const reset = () => {
        setContactQuery(''); setCandidates([]); setSelectedContact(null);
        setNewName(''); setNewPhone(''); setNewEmail('');
        setAddress(EMPTY_ADDRESS);
        setSlot(null);
        setPreferredTechId(undefined);
        setJobType(''); setJobSource(''); setMetadata({}); setDescription('');
    };
    const close = () => { reset(); onClose(); };

    // Pre-fill from a copied job on open. The blank "New job" path (copyFrom
    // null/undefined) is left untouched so it stays empty. Keyed on [open, copyFrom]
    // so re-opening repopulates. The timeslot is intentionally NOT copied.
    useEffect(() => {
        if (!open || !copyFrom) return;
        setSelectedContact(copyFrom.contact ?? null);
        setAddress(copyFrom.address);
        setJobType(copyFrom.jobType);
        setDescription(copyFrom.description);
        setPreferredTechId(copyFrom.techId);
        setSlot(null);
    }, [open, copyFrom]);

    // Pre-set the timeslot when opened from a calendar slot. Stays editable.
    useEffect(() => {
        if (open && presetSlot) {
            setSlot({ start: presetSlot.start, end: presetSlot.end, techId: presetSlot.techId, formatted: presetSlot.formatted || '' });
        }
    }, [open, presetSlot]);

    // Debounced broad contact search (name, phone, email, address — backend `q`)
    const runSearch = useCallback(async (q: string) => {
        const trimmed = q.trim();
        if (trimmed.length < 2) { setCandidates([]); return; }
        setSearching(true);
        try {
            const res = await contactsApi.searchCandidates({ q: trimmed });
            setCandidates(res.data.candidates);
        } catch { setCandidates([]); }
        finally { setSearching(false); }
    }, []);

    const handleQueryChange = (v: string) => {
        setContactQuery(v);
        // lightweight debounce
        window.clearTimeout((handleQueryChange as any)._t);
        (handleQueryChange as any)._t = window.setTimeout(() => runSearch(v), 350);
    };

    const pickContact = (
        c: DedupeCandidate,
        addr?: { line1: string | null; line2: string | null; city: string | null; state: string | null; postal_code: string | null; lat?: number | null; lng?: number | null }
    ) => {
        const name = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone_e164 || `Contact #${c.id}`;
        setSelectedContact({ id: c.id, name });
        if (addr) {
            setAddress({
                street: addr.line1 ?? '',
                apt: addr.line2 ?? '',
                city: addr.city ?? '',
                state: addr.state ?? '',
                zip: addr.postal_code ?? '',
                lat: addr.lat ?? null,
                lng: addr.lng ?? null,
            });
        }
        setCandidates([]);
        setContactQuery('');
    };
    const clearContact = () => setSelectedContact(null);

    const handleSlotConfirm = (s: { type: 'arrival_window'; start: string; end: string; formatted: string; techId?: string }) => {
        setSlot({ start: s.start, end: s.end, techId: s.techId, formatted: s.formatted });
        setTimeOpen(false);
    };

    // Submit gating: contact present (selected OR name+phone), address (zip), slot, job_type
    const hasContact = !!selectedContact || (!!newName.trim() && !!newPhone.trim());
    const canSubmit = hasContact && !!address.zip.trim() && !!slot && !!jobType.trim() && !submitting;

    const handleSubmit = async () => {
        if (!slot) return;
        const contact: CreateJobBody['contact'] = selectedContact
            ? { contact_id: selectedContact.id }
            : { name: newName.trim(), phone: newPhone.trim(), ...(newEmail.trim() && { email: newEmail.trim() }) };

        const body: CreateJobBody = {
            contact,
            address: {
                ...(address.street && { line1: address.street }),
                ...(address.apt && { line2: address.apt }),
                ...(address.city && { city: address.city }),
                ...(address.state && { state: address.state }),
                ...(address.zip && { postal_code: address.zip }),
                lat: address.lat ?? coords?.lat ?? null,
                lng: address.lng ?? coords?.lng ?? null,
            },
            slot: { start: slot.start, end: slot.end, tech_id: slot.techId ?? null },
            job_type: jobType.trim(),
            ...(description.trim() && { description: description.trim() }),
            ...(jobSource && { lead_source: jobSource }),
            ...(Object.keys(metadata).length > 0 && { metadata }),
        };

        setSubmitting(true);
        try {
            const data = await createJob(body);
            if (data.zb_warning) {
                toast.warning('Job created but Zenbooker failed', {
                    description: data.zb_warning,
                    duration: 15000,
                    action: { label: 'Open Job', onClick: () => navigate(`/jobs/${data.job_id}`) },
                });
            } else {
                toast.success('Job created', {
                    description: data.zenbooker_job_id ? `Zenbooker Job: ${data.zenbooker_job_id}` : `Local Job #${data.job_id}`,
                    duration: 10000,
                });
            }
            navigate(`/jobs/${data.job_id}`);
            close();
        } catch (err) {
            toast.error('Failed to create job', { description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <>
            <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            {copyFrom ? 'New job (copy)' : 'New job'}
                        </DialogTitle>
                        <DialogDescription className="sr-only">Create a job directly</DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {/* Contact */}
                        {selectedContact ? (
                            <div className="cld-contact-badge w-fit">
                                <Check style={{ width: 16, height: 16, color: 'var(--blanc-success)', flexShrink: 0 }} />
                                <span className="cld-contact-badge__text">{selectedContact.name}</span>
                                <button type="button" onClick={clearContact} className="cld-contact-badge__remove">
                                    <X style={{ width: 12, height: 12 }} /> Remove
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-3.5">
                                <div className="relative">
                                    <Input
                                        className="h-[50px] rounded-xl bg-transparent text-[15px]"
                                        placeholder="Search an existing contact by name or phone…"
                                        value={contactQuery}
                                        onChange={(e) => handleQueryChange(e.target.value)}
                                    />
                                    {(searching || candidates.length > 0) && contactQuery.trim().length >= 2 && (
                                        <div className="cld-candidates">
                                            {searching && <div className="cld-candidates__header">Searching…</div>}
                                            {!searching && candidates.length === 0 && (
                                                <div className="cld-candidates__header">No matches — fill the fields below to create a new contact</div>
                                            )}
                                            {candidates.flatMap((c) => {
                                                const name = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unnamed';
                                                const rows = c.addresses?.length
                                                    ? c.addresses.map((addr, addrIndex) => {
                                                        const addrText = [addr.line1, [addr.city, addr.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
                                                        return (
                                                            <div key={`${c.id}-${addrIndex}`} onClick={() => pickContact(c, addr)} className="cld-candidates__item">
                                                                <div className="cld-candidates__info">
                                                                    <div className="cld-candidates__name">
                                                                        <span>{name}</span>
                                                                    </div>
                                                                    <div className="cld-candidates__meta">
                                                                        {addrText && <span className="cld-candidates__meta-item">{addrText}</span>}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })
                                                    : [(
                                                        <div key={`${c.id}-0`} onClick={() => pickContact(c)} className="cld-candidates__item">
                                                            <div className="cld-candidates__info">
                                                                <div className="cld-candidates__name">
                                                                    <span>{name}</span>
                                                                </div>
                                                                <div className="cld-candidates__meta">
                                                                    {c.phone_e164 && <span className="cld-candidates__meta-item">{c.phone_e164}</span>}
                                                                    {c.email && <span className="cld-candidates__meta-item">{c.email}</span>}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )];
                                                return rows;
                                            })}
                                        </div>
                                    )}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <FloatingField id="njd-name" label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                                    <FloatingField id="njd-phone" label="Phone" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                                </div>
                                <FloatingField id="njd-email" label="Email (optional)" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                            </div>
                        )}

                        {/* Address */}
                        <AddressAutocomplete
                            idPrefix="njd"
                            defaultUseDetails
                            hideDetailsToggle
                            value={address}
                            onChange={setAddress}
                        />

                        {/* Time & technician */}
                        {slot ? (
                            <button
                                type="button"
                                onClick={() => setTimeOpen(true)}
                                className="w-full text-left rounded-xl px-4 h-[50px] flex items-center gap-3 transition-colors hover:bg-[rgba(25,25,25,0.03)]"
                                style={{ border: '1.5px solid var(--blanc-line)' }}
                            >
                                <Clock style={{ width: 18, height: 18, color: 'var(--blanc-ink-3)', flexShrink: 0 }} />
                                <span className="text-[15px]" style={{ color: 'var(--blanc-ink-1)' }}>{slot.formatted}</span>
                                <span className="ml-auto text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>Change</span>
                            </button>
                        ) : (
                            <Button type="button" variant="secondary" className="w-full justify-center h-[50px] text-[15px] rounded-xl" onClick={() => setTimeOpen(true)}>
                                <Clock className="size-4 mr-2" /> Pick time &amp; provider
                            </Button>
                        )}

                        {/* Work — Job type + Lead source are the same shared data as New Lead */}
                        <div className="space-y-3.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingSelect id="njd-type" label="Job type" value={jobType} onValueChange={setJobType}>
                                    {jobTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                                </FloatingSelect>
                                <FloatingSelect id="njd-source" label="Lead source" value={jobSource} onValueChange={setJobSource}>
                                    {JOB_SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                </FloatingSelect>
                            </div>
                            <FloatingField id="njd-desc" label="Details (the problem)" textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
                        </div>

                        {/* Additional info — same custom fields as New Lead (only if configured) */}
                        {customFields.length > 0 && (
                            <div className="space-y-3.5">
                                <div className="cld-eyebrow">Additional info</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    {customFields.map(field => {
                                        const isLong = field.field_type === 'textarea' || field.field_type === 'richtext';
                                        return isLong
                                            ? <FloatingField key={field.id} id={`njd-meta-${field.api_name}`} label={field.display_name} textarea rows={3} className="sm:col-span-2" value={metadata[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} />
                                            : <FloatingField key={field.id} id={`njd-meta-${field.api_name}`} label={field.display_name} type={field.field_type === 'number' ? 'number' : 'text'} inputMode={field.field_type === 'number' ? 'decimal' : undefined} value={metadata[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} />;
                                    })}
                                </div>
                            </div>
                        )}
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button variant="ghost" onClick={close} disabled={submitting}>Cancel</Button>
                        <Button onClick={handleSubmit} disabled={!canSubmit}>
                            {submitting ? <Loader2 className="size-4 mr-1 animate-spin" /> : null}
                            Create job
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <CustomTimeModal
                open={timeOpen}
                onClose={() => setTimeOpen(false)}
                onConfirm={handleSlotConfirm}
                territoryId={territoryId}
                newJobCoords={coords}
                newJobAddress={composeAddress(address) || undefined}
                newJobDuration={120}
                initialSlot={slot ? { techId: slot.techId || '', start: slot.start, end: slot.end } : undefined}
                preselectTechId={slot?.techId ?? preferredTechId}
            />
        </>
    );
}

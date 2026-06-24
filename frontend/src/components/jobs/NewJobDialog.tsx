/**
 * NewJobDialog — create a Job directly (no lead, no wizard steps).
 *
 * One screen, four blocks: Contact · Address · Time & technician · Work.
 * The chosen Zenbooker slot (via CustomTimeModal) gives BOTH the arrival window
 * AND the technician (techId) in a single pick. Minimal fields only — no price,
 * duration, territory, or other internal fields.
 */
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, X, Clock, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { FloatingField } from '../ui/floating-field';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { EMPTY_ADDRESS, type AddressFields } from '../addressAutoHelpers';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { useZipCheck } from '../../hooks/useZipCheck';
import * as contactsApi from '../../services/contactsApi';
import { createJob, type CreateJobBody } from '../../services/jobsApi';
import type { DedupeCandidate } from '../../types/contact';
import '../leads/CreateLeadDialog.css';

interface NewJobDialogProps {
    open: boolean;
    onClose: () => void;
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


export function NewJobDialog({ open, onClose }: NewJobDialogProps) {
    const navigate = useNavigate();

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

    // ── Work ──
    const [jobType, setJobType] = useState('');
    const [description, setDescription] = useState('');

    const [submitting, setSubmitting] = useState(false);

    const reset = () => {
        setContactQuery(''); setCandidates([]); setSelectedContact(null);
        setNewName(''); setNewPhone(''); setNewEmail('');
        setAddress(EMPTY_ADDRESS);
        setSlot(null);
        setJobType(''); setDescription('');
    };
    const close = () => { reset(); onClose(); };

    // Debounced contact search by phone/name
    const runSearch = useCallback(async (q: string) => {
        const trimmed = q.trim();
        if (trimmed.length < 2) { setCandidates([]); return; }
        const byPhone = /\d/.test(trimmed);
        setSearching(true);
        try {
            const res = await contactsApi.searchCandidates(
                byPhone ? { phone: trimmed } : { first_name: trimmed }
            );
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

    const pickContact = (c: DedupeCandidate) => {
        const name = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone_e164 || `Contact #${c.id}`;
        setSelectedContact({ id: c.id, name });
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
                            New job
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
                                            {candidates.map((c) => (
                                                <div key={c.id} onClick={() => pickContact(c)} className="cld-candidates__item">
                                                    <div className="cld-candidates__info">
                                                        <div className="cld-candidates__name">
                                                            <span>{c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unnamed'}</span>
                                                        </div>
                                                        <div className="cld-candidates__meta">
                                                            {c.phone_e164 && <span className="cld-candidates__meta-item">{c.phone_e164}</span>}
                                                            {c.email && <span className="cld-candidates__meta-item">{c.email}</span>}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
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
                                className="w-full text-left rounded-xl px-4 h-[50px] flex items-center gap-3 transition-colors hover:bg-[rgba(117,106,89,0.04)]"
                                style={{ border: '1.5px solid var(--blanc-line)' }}
                            >
                                <Clock style={{ width: 18, height: 18, color: 'var(--blanc-ink-3)', flexShrink: 0 }} />
                                <span className="text-[15px]" style={{ color: 'var(--blanc-ink-1)' }}>{slot.formatted}</span>
                                <span className="ml-auto text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>Change</span>
                            </button>
                        ) : (
                            <Button type="button" variant="secondary" className="w-full justify-center h-[50px] text-[15px] rounded-xl" onClick={() => setTimeOpen(true)}>
                                <Clock className="size-4 mr-2" /> Pick time &amp; technician
                            </Button>
                        )}

                        {/* Work */}
                        <div className="space-y-3.5">
                            <FloatingField id="njd-type" label="Job type" value={jobType} onChange={(e) => setJobType(e.target.value)} />
                            <FloatingField id="njd-desc" label="Details (the problem)" textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
                        </div>
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
            />
        </>
    );
}

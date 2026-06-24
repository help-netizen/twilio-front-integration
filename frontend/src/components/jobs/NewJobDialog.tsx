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

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
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
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>New Job</DialogTitle>
                        <DialogDescription className="sr-only">Create a job directly</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-5 py-1">
                        {/* ── Contact ── */}
                        <section className="space-y-2">
                            <div className="blanc-eyebrow">Contact</div>
                            {selectedContact ? (
                                <div className="cld-contact-badge">
                                    <Check style={{ width: 16, height: 16, color: 'var(--blanc-success)', flexShrink: 0 }} />
                                    <span className="cld-contact-badge__text">{selectedContact.name}</span>
                                    <button type="button" onClick={clearContact} className="cld-contact-badge__remove">
                                        <X style={{ width: 12, height: 12 }} /> Remove
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="relative">
                                        <Input
                                            placeholder="Search by name or phone…"
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
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="njd-name" className="text-sm font-medium">Name</Label>
                                            <Input id="njd-name" value={newName} placeholder="Jane Doe" onChange={(e) => setNewName(e.target.value)} />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label htmlFor="njd-phone" className="text-sm font-medium">Phone</Label>
                                            <Input id="njd-phone" value={newPhone} placeholder="(555) 123-4567" onChange={(e) => setNewPhone(e.target.value)} />
                                        </div>
                                        <div className="space-y-1.5 col-span-2">
                                            <Label htmlFor="njd-email" className="text-sm font-medium">Email <span style={{ color: 'var(--blanc-ink-3)' }}>(optional)</span></Label>
                                            <Input id="njd-email" value={newEmail} placeholder="jane@example.com" onChange={(e) => setNewEmail(e.target.value)} />
                                        </div>
                                    </div>
                                </>
                            )}
                        </section>

                        {/* ── Address ── */}
                        <section className="space-y-2">
                            <AddressAutocomplete
                                header={<div className="blanc-eyebrow">Address</div>}
                                idPrefix="njd"
                                defaultUseDetails
                                value={address}
                                onChange={setAddress}
                            />
                        </section>

                        {/* ── Time & technician ── */}
                        <section className="space-y-2">
                            <div className="blanc-eyebrow">Time & technician</div>
                            {slot ? (
                                <button
                                    type="button"
                                    onClick={() => setTimeOpen(true)}
                                    className="w-full text-left rounded-xl px-3 py-2.5 flex items-center gap-2"
                                    style={{ border: '1px solid var(--blanc-line)' }}
                                >
                                    <Clock style={{ width: 16, height: 16, color: 'var(--blanc-ink-3)', flexShrink: 0 }} />
                                    <span className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{slot.formatted}</span>
                                </button>
                            ) : (
                                <Button type="button" variant="outline" className="w-full" onClick={() => setTimeOpen(true)}>
                                    <Clock className="size-4 mr-1.5" /> Pick time & technician
                                </Button>
                            )}
                        </section>

                        {/* ── Work ── */}
                        <section className="space-y-2">
                            <div className="blanc-eyebrow">Work</div>
                            <div className="space-y-1.5">
                                <Label htmlFor="njd-type" className="text-sm font-medium">Job type</Label>
                                <Input id="njd-type" value={jobType} placeholder="e.g. Dishwasher repair" onChange={(e) => setJobType(e.target.value)} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="njd-desc" className="text-sm font-medium">Description <span style={{ color: 'var(--blanc-ink-3)' }}>(the problem)</span></Label>
                                <Textarea id="njd-desc" value={description} placeholder="What's wrong / what needs doing" onChange={(e) => setDescription(e.target.value)} rows={3} />
                            </div>
                        </section>
                    </div>

                    <DialogFooter>
                        <Button variant="ghost" onClick={close} disabled={submitting}>Cancel</Button>
                        <Button onClick={handleSubmit} disabled={!canSubmit}>
                            {submitting ? <Loader2 className="size-4 mr-1 animate-spin" /> : null}
                            Create job
                        </Button>
                    </DialogFooter>
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

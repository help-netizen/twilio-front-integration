/**
 * PulseContactPanel — contact detail view for the Pulse content column.
 *
 * Layout:
 *   Header — name, company, phone, email + Notes (sticky note, right side)
 *   Body   — Left: Leads & Jobs | Right: Addresses
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Mail, TrendingUp, Briefcase, MapPin, Check } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import * as contactsApi from '../../services/contactsApi';
import * as jobsApi from '../../services/jobsApi';
import { EditContactDialog } from './EditContactDialog';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import type { Contact, ContactLead } from '../../types/contact';
import { getLeadStatusColor, getJobStatusStyle, AddressCard } from './PulseContactHelpers';

interface PulseContactPanelProps { contact: Contact; leads: ContactLead[]; loading: boolean; onAddressesChanged?: () => void; onContactChanged?: () => void; }

const ZENBOOKER_BASE_URL = 'https://zenbooker.com';

/* No background cards — clean flat layout, content breathes */

export function PulseContactPanel({ contact, leads, loading, onAddressesChanged, onContactChanged }: PulseContactPanelProps) {
    const navigate = useNavigate();
    const [editOpen, setEditOpen] = useState(false);
    const [onlyOpenLeads, setOnlyOpenLeads] = useState(true);
    const [notes, setNotes] = useState(contact.notes || '');
    const [notesFocused, setNotesFocused] = useState(false);
    const [jobs, setJobs] = useState<jobsApi.LocalJob[]>([]);
    const [jobsLoaded, setJobsLoaded] = useState(false);
    const [editingEmail, setEditingEmail] = useState(false);
    const [emailDraft, setEmailDraft] = useState('');
    const [emailError, setEmailError] = useState(false);
    const [emailSaving, setEmailSaving] = useState(false);
    const emailInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setNotes(contact.notes || ''); }, [contact.notes]);
    useEffect(() => {
        if (!contact.id) return;
        setJobsLoaded(false);
        jobsApi.listJobs({ contact_id: contact.id, limit: 50 })
            .then(data => { setJobs(data.results); setJobsLoaded(true); })
            .catch(() => { setJobs([]); setJobsLoaded(true); });
    }, [contact.id]);

    const filteredLeads = onlyOpenLeads ? leads.filter(l => !['Lost', 'Converted'].includes(l.status)) : leads;
    const hasActivity = filteredLeads.length > 0 || jobs.length > 0;

    const handleSaveNotes = async () => {
        setNotesFocused(false);
        if (notes === (contact.notes || '')) return;
        try {
            await contactsApi.updateContact(contact.id, { notes });
            onContactChanged?.();
        } catch {
            toast.error('Failed to save notes');
        }
    };

    const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    const handleStartEmailEdit = () => { setEmailDraft(''); setEmailError(false); setEditingEmail(true); setTimeout(() => emailInputRef.current?.focus(), 0); };
    const handleSaveEmail = async () => {
        const trimmed = emailDraft.trim();
        if (!trimmed || !isValidEmail(trimmed)) { setEmailError(true); return; }
        setEmailSaving(true);
        try {
            await contactsApi.updateContact(contact.id, { email: trimmed });
            setEditingEmail(false);
            onContactChanged?.();
        } catch { toast.error('Failed to save email'); }
        finally { setEmailSaving(false); }
    };

    const zbLink = contact.zenbooker_id
        ? `${ZENBOOKER_BASE_URL}/app?view=customers&customer=${contact.zenbooker_id}`
        : null;

    if (loading) return <div className="p-5 space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-36" /><Skeleton className="h-4 w-56" /><Skeleton className="h-20 w-full" /></div>;

    return (
        <div className="flex flex-col" style={{ background: 'var(--blanc-surface-strong)' }}>
            {/* ── Header: two-column grid — left: identity+contacts, right: notes ── */}
            <div className="pulse-contact-header-grid px-5 pt-5 pb-4">
                {/* Left: Name + contacts */}
                <div>
                    {/* Name + ZB + Edit */}
                    <div className="flex items-center gap-2 mb-1">
                        <h2 className="font-bold text-2xl leading-tight truncate" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>
                            {contact.full_name || 'Unknown'}
                        </h2>
                        {zbLink && (
                            <a href={zbLink} target="_blank" rel="noopener noreferrer" title="Open in Zenbooker" className="inline-flex items-center justify-center shrink-0 rounded-md transition-colors hover:bg-muted/60" style={{ width: 22, height: 22 }}>
                                <span className="text-[9px] font-bold leading-none" style={{ color: 'var(--blanc-ink-3)' }}>ZB</span>
                            </a>
                        )}
                        <button onClick={() => setEditOpen(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors shrink-0" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)' }}>Edit</button>
                    </div>
                    {contact.company_name && <p className="text-sm mb-3" style={{ color: 'var(--blanc-ink-3)' }}>{contact.company_name}</p>}
                    {!contact.company_name && <div className="mb-3" />}

                    {/* Phone + Email */}
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Phone className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <a href={`tel:${contact.phone_e164}`} className="text-[15px] font-semibold text-foreground no-underline hover:underline">{formatPhone(contact.phone_e164)}</a>
                            <ClickToCallButton phone={contact.phone_e164 || ''} contactName={contact.full_name || undefined} />
                            <OpenTimelineButton phone={contact.phone_e164 || ''} contactId={contact.id} />
                        </div>
                        {contact.secondary_phone && (
                            <div className="flex items-center gap-2">
                                <Phone className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                <a href={`tel:${contact.secondary_phone}`} className="text-sm text-foreground no-underline hover:underline">{formatPhone(contact.secondary_phone)}</a>
                                {contact.secondary_phone_name && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{contact.secondary_phone_name}</span>}
                                <ClickToCallButton phone={contact.secondary_phone} contactName={contact.full_name || undefined} />
                                <OpenTimelineButton phone={contact.secondary_phone || ''} contactId={contact.id} />
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <Mail className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            {contact.email ? (
                                <a href={`mailto:${contact.email}`} className="text-sm text-foreground no-underline hover:underline">{contact.email}</a>
                            ) : editingEmail ? (
                                <div className="flex items-center gap-1.5 flex-1">
                                    <input
                                        ref={emailInputRef}
                                        type="email"
                                        value={emailDraft}
                                        onChange={e => { setEmailDraft(e.target.value); setEmailError(false); }}
                                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSaveEmail(); } if (e.key === 'Escape') setEditingEmail(false); }}
                                        placeholder="email@example.com"
                                        className="text-sm border-none outline-none bg-transparent flex-1 min-w-0"
                                        style={{ borderBottom: `1.5px solid ${emailError ? 'var(--blanc-danger)' : 'var(--blanc-line)'}`, paddingBottom: 2 }}
                                        disabled={emailSaving}
                                    />
                                    <button onClick={handleSaveEmail} disabled={emailSaving} className="inline-flex items-center justify-center size-6 rounded-md transition-colors shrink-0" style={{ background: 'var(--blanc-success)', color: '#fff' }} title="Save">
                                        <Check className="size-3.5" />
                                    </button>
                                </div>
                            ) : (
                                <button onClick={handleStartEmailEdit} className="text-sm" style={{ color: 'var(--blanc-ink-3)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: '3px' }}>
                                    add email
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Right: Notes — sticky note, aligned with name */}
                <div style={{ padding: '14px 16px 16px', borderRadius: 16, background: '#fef9e7', borderLeft: '3px solid #f6d860' }}>
                    <h4 className="blanc-eyebrow mb-2">Notes</h4>
                    <textarea
                        ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                        className="w-full text-sm resize-none bg-transparent border-none outline-none leading-6"
                        style={{ minHeight: 36, color: notes ? 'var(--blanc-ink-1)' : undefined }}
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        onFocus={() => setNotesFocused(true)}
                        onBlur={handleSaveNotes}
                        onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                        placeholder="Add notes…"
                        rows={2}
                    />
                </div>
            </div>

            {/* ── Body ── */}
            <div className="grid grid-cols-2 gap-x-6 px-5 pb-5">
                {/* Left column — Leads & Jobs */}
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <h4 className="blanc-eyebrow" style={{ marginBottom: 0 }}>Leads & Jobs</h4>
                        <Switch id="pulse-leads-only-open" checked={onlyOpenLeads} onCheckedChange={setOnlyOpenLeads} />
                        <Label htmlFor="pulse-leads-only-open" className="cursor-pointer text-xs">Only Open</Label>
                    </div>

                    {!jobsLoaded && <div className="text-xs text-muted-foreground py-2">Loading…</div>}

                    {jobsLoaded && !hasActivity && (
                        <div className="text-center text-muted-foreground text-sm py-6">
                            {onlyOpenLeads ? 'No open leads or jobs' : 'No leads or jobs'}
                        </div>
                    )}

                    {hasActivity && (
                        <div className="space-y-2">
                            {filteredLeads.map(lead => (
                                <div key={`lead-${lead.id}`} onClick={() => navigate(`/leads/${lead.id}`)} className="p-3 rounded-xl cursor-pointer transition-all" style={{ border: '1px solid var(--blanc-line)' }} onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(104,95,80,0.3)')} onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}>
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <TrendingUp className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>{lead.job_type || 'Lead'}</div>
                                                <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{lead.created_at ? format(new Date(lead.created_at), 'MMM dd, yyyy') : '—'}{lead.job_source && ` · ${lead.job_source}`}</div>
                                            </div>
                                        </div>
                                        <span className="px-2 py-0.5 rounded-md text-xs font-semibold shrink-0" style={{ backgroundColor: `${getLeadStatusColor(lead.status)}15`, color: getLeadStatusColor(lead.status) }}>{lead.status}</span>
                                    </div>
                                    {lead.lead_notes && <div className="text-xs text-muted-foreground mt-1.5 pl-[22px] truncate">{lead.lead_notes}</div>}
                                </div>
                            ))}

                            {jobs.map(job => {
                                const st = getJobStatusStyle(job.blanc_status);
                                const date = job.start_date ? new Date(job.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                                return (
                                    <div key={`job-${job.id}`} onClick={() => navigate(`/jobs/${job.id}`)} className="p-3 rounded-xl cursor-pointer transition-all" style={{ border: '1px solid var(--blanc-line)' }} onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(104,95,80,0.3)')} onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}>
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <Briefcase className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                                <div className="min-w-0">
                                                    <div className="text-sm font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>{job.service_name || 'Job'}</div>
                                                    <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                                        {job.job_number && `#${job.job_number}`}
                                                        {date && (job.job_number ? ` · ${date}` : date)}
                                                    </div>
                                                </div>
                                            </div>
                                            <span className="px-2 py-0.5 rounded-md text-xs font-semibold shrink-0" style={{ backgroundColor: st.bg, color: st.color }}>{job.blanc_status}</span>
                                        </div>
                                        {job.assigned_techs && job.assigned_techs.length > 0 && (
                                            <div className="text-xs text-muted-foreground mt-1.5 pl-[22px] truncate">
                                                {job.assigned_techs.map((p: any) => p.name).join(', ')}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Right column — Addresses */}
                <div>
                    <h4 className="blanc-eyebrow flex items-center gap-1.5 mb-3"><MapPin className="size-3.5" />Addresses ({contact.addresses.length})</h4>
                    {contact.addresses.length === 0
                        ? <div className="text-sm text-muted-foreground py-2">No addresses</div>
                        : contact.addresses.map((addr, i) => <AddressCard key={addr.id || i} address={addr} index={i} contactId={contact.id} onSaved={() => onAddressesChanged?.()} />)}
                </div>
            </div>

            <EditContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} onSuccess={() => onContactChanged?.()} />
        </div>
    );
}

/**
 * ContactDetailPanel — two-column layout matching Lead/Job panels.
 *
 * LEFT:  Header (name + company) → Contact tile (phone/email) → Address tiles
 * RIGHT: Notes (editable) → Activity (leads + jobs combined)
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, RefreshCw, Activity, CloudUpload, Loader2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import type { Contact, ContactLead } from '../../types/contact';
import * as contactsApi from '../../services/contactsApi';
import { pulseApi } from '../../services/pulseApi';
import { ContactInfoSections } from './ContactInfoSections';
import { EditContactDialog } from './EditContactDialog';
import { JobsList } from './ContactJobsList';

// ─── Status color helpers ────────────────────────────────────────────────────

const LEAD_STATUS_COLORS: Record<string, string> = {
    'Submitted': '#3B82F6', 'New': '#8B5CF6', 'Contacted': '#1B8B63',
    'Qualified': '#22C55E', 'Proposal Sent': '#F59E0B',
    'Negotiation': '#F97316', 'Lost': '#EF4444', 'Converted': '#6B7280',
};

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface ContactDetailPanelProps {
    contact: Contact;
    leads: ContactLead[];
    loading: boolean;
    onAddressesChanged?: () => void;
    onContactChanged?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ContactDetailPanel({ contact, leads, loading, onAddressesChanged, onContactChanged }: ContactDetailPanelProps) {
    const navigate = useNavigate();
    const [editOpen, setEditOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [notes, setNotes] = useState(contact.notes || '');
    const [onlyOpen, setOnlyOpen] = useState(true);

    useEffect(() => {
        setNotes(contact.notes || '');
    }, [contact.id, contact.notes]);

    const handleSaveNotes = async () => {
        if (notes === (contact.notes || '')) return;
        try {
            await contactsApi.updateContact(contact.id, { notes });
            onContactChanged?.();
        } catch { toast.error('Failed to save notes'); }
    };

    const handleSync = async () => {
        setSyncing(true);
        try {
            if (contact.zenbooker_customer_id) {
                await contactsApi.syncToZenbooker(contact.id);
                toast.success('Synced to Zenbooker');
            } else {
                await contactsApi.createZenbookerCustomer(contact.id);
                toast.success('Created in Zenbooker');
            }
            onContactChanged?.();
        } catch (err) {
            toast.error('Sync failed', { description: err instanceof Error ? err.message : '' });
        } finally { setSyncing(false); }
    };

    const handleViewInPulse = async () => {
        if (contact.phone_e164) {
            try {
                const tl = await pulseApi.ensureTimeline(contact.phone_e164);
                navigate(`/pulse/timeline/${tl.timelineId}`);
            } catch { navigate('/pulse'); }
        } else { navigate('/pulse'); }
    };

    const filteredLeads = onlyOpen
        ? leads.filter(l => l.status !== 'Lost' && l.status !== 'Converted')
        : leads;

    if (loading) {
        return (
            <div className="p-6 space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-32 w-full rounded-xl" />
                <Skeleton className="h-32 w-full rounded-xl" />
            </div>
        );
    }

    return (
        <>
            <div className="flex flex-col md:flex-row h-full overflow-hidden">

                {/* ═══ LEFT COLUMN — Identity + Tiles ═══ */}
                <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
                    {/* Header */}
                    <div className="px-5 pt-5 pb-3">
                        {/* Eyebrow */}
                        <div className="mb-2">
                            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--blanc-info)', letterSpacing: '0.12em' }}>
                                Contact
                            </span>
                        </div>

                        {/* Name + action icons */}
                        <div className="flex items-center gap-2 mb-1">
                            <h2
                                className="text-2xl font-bold leading-tight truncate"
                                style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)', letterSpacing: '-0.03em' }}
                            >
                                {contact.full_name || 'Unknown'}
                            </h2>
                            <div className="flex items-center gap-1 ml-auto shrink-0">
                                <button onClick={handleViewInPulse} title="View in Pulse" className="p-1.5 rounded-lg transition-opacity hover:opacity-70" style={{ color: 'var(--blanc-ink-3)' }}>
                                    <Activity className="size-3.5" />
                                </button>
                                <button onClick={() => setEditOpen(true)} title="Edit contact" className="p-1.5 rounded-lg transition-opacity hover:opacity-70" style={{ color: 'var(--blanc-ink-3)' }}>
                                    <Pencil className="size-3.5" />
                                </button>
                                <button onClick={handleSync} disabled={syncing} title={contact.zenbooker_customer_id ? 'Sync to Zenbooker' : 'Create in Zenbooker'} className="p-1.5 rounded-lg transition-opacity hover:opacity-70 disabled:opacity-40" style={{ color: 'var(--blanc-ink-3)' }}>
                                    {syncing ? <Loader2 className="size-3.5 animate-spin" /> : contact.zenbooker_customer_id ? <RefreshCw className="size-3.5" /> : <CloudUpload className="size-3.5" />}
                                </button>
                            </div>
                        </div>

                        {contact.company_name && (
                            <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>{contact.company_name}</p>
                        )}
                    </div>

                    {/* Contact + Address tiles */}
                    <ContactInfoSections contact={contact} onAddressesChanged={onAddressesChanged} />

                    {/* Mobile-only: right column content inline */}
                    <div className="md:hidden px-5 pb-6 space-y-5">
                        <NotesCard notes={notes} setNotes={setNotes} onSave={handleSaveNotes} />
                        <ActivitySection leads={filteredLeads} contactId={contact.id} onlyOpen={onlyOpen} onOnlyOpenChange={setOnlyOpen} />
                    </div>
                </div>

                {/* ═══ RIGHT COLUMN (desktop) ═══ */}
                <div
                    className="w-full md:w-1/2 flex-col overflow-y-auto hidden md:flex"
                    style={{ borderLeft: '1px solid rgba(117, 106, 89, 0.07)' }}
                >
                    <div className="p-4 space-y-5">
                        <NotesCard notes={notes} setNotes={setNotes} onSave={handleSaveNotes} />
                        <ActivitySection leads={filteredLeads} contactId={contact.id} onlyOpen={onlyOpen} onOnlyOpenChange={setOnlyOpen} />
                        {/* Timestamps */}
                        <div className="flex gap-6 text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>
                            {contact.created_at && <span>Created: {new Date(contact.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                            {contact.updated_at && <span>Updated: {new Date(contact.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                        </div>
                    </div>
                </div>
            </div>

            <EditContactDialog
                open={editOpen}
                onOpenChange={setEditOpen}
                contact={contact}
                onSuccess={() => { setEditOpen(false); onContactChanged?.(); }}
            />
        </>
    );
}

// ─── Notes Card ──────────────────────────────────────────────────────────────

function NotesCard({ notes, setNotes, onSave }: { notes: string; setNotes: (v: string) => void; onSave: () => void }) {
    return (
        <div style={{ padding: '14px 16px 16px', borderRadius: 16, background: '#fef9e7', borderLeft: '3px solid #f6d860' }}>
            <h4 className="blanc-eyebrow mb-2">Notes</h4>
            <textarea
                ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                className="w-full text-sm resize-none bg-transparent border-none outline-none leading-6"
                style={{ minHeight: 36, color: notes ? 'var(--blanc-ink-1)' : undefined }}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                onBlur={onSave}
                onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                placeholder="Add notes…"
                rows={2}
            />
        </div>
    );
}

// ─── Activity Section (Leads + Jobs combined) ────────────────────────────────

function ActivitySection({ leads, contactId, onlyOpen, onOnlyOpenChange }: {
    leads: ContactLead[];
    contactId: number;
    onlyOpen: boolean;
    onOnlyOpenChange: (v: boolean) => void;
}) {
    const navigate = useNavigate();

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h4 className="blanc-eyebrow" style={{ marginBottom: 0 }}>Leads &amp; Jobs</h4>
                <div className="flex items-center gap-2">
                    <Switch id="contact-only-open" checked={onlyOpen} onCheckedChange={onOnlyOpenChange} />
                    <label htmlFor="contact-only-open" className="text-[11px] font-medium cursor-pointer" style={{ color: 'var(--blanc-ink-3)' }}>Only Open</label>
                </div>
            </div>

            {/* Leads */}
            {leads.length > 0 && (
                <div className="space-y-2 mb-3">
                    {leads.map(lead => {
                        const color = LEAD_STATUS_COLORS[lead.status] || '#6B7280';
                        return (
                            <div
                                key={lead.id}
                                onClick={() => navigate(`/leads/${lead.id}`)}
                                className="flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all hover:shadow-sm"
                                style={{ border: '1px solid var(--blanc-line)', background: 'transparent' }}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[13px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{lead.job_type || 'Lead'}</span>
                                        <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: hexToRgba(color, 0.1), color }}>
                                            {lead.status}
                                        </span>
                                        <span className="text-[11px] font-mono" style={{ color: 'var(--blanc-ink-3)' }}>#{lead.serial_id}</span>
                                    </div>
                                    <div className="text-[12px] mt-1" style={{ color: 'var(--blanc-ink-3)' }}>
                                        {new Date(lead.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                        {lead.job_source && ` · ${lead.job_source}`}
                                    </div>
                                </div>
                                <ChevronRight className="size-3.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Jobs */}
            <JobsList contactId={contactId} />
        </div>
    );
}

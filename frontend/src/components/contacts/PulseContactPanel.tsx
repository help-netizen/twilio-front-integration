/**
 * PulseContactPanel — contact detail view for the Pulse content column.
 * Uses two-column grid layout to fill the wider card.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Mail, ExternalLink, TrendingUp, FileText, User, MapPin, RefreshCw, CloudUpload, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import * as contactsApi from '../../services/contactsApi';
import { EditContactDialog } from './EditContactDialog';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import type { Contact, ContactLead } from '../../types/contact';
import { getLeadStatusColor, JobsList, AddressCard } from './PulseContactHelpers';

interface PulseContactPanelProps { contact: Contact; leads: ContactLead[]; loading: boolean; onAddressesChanged?: () => void; onContactChanged?: () => void; }

const ZENBOOKER_BASE_URL = 'https://zenbooker.com';
const ZENBOOKER_SYNC_ENABLED = import.meta.env.VITE_FEATURE_ZENBOOKER_SYNC === 'true';

export function PulseContactPanel({ contact, leads, loading, onAddressesChanged, onContactChanged }: PulseContactPanelProps) {
    const navigate = useNavigate();
    const [editOpen, setEditOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [onlyOpenLeads, setOnlyOpenLeads] = useState(true);
    const filteredLeads = onlyOpenLeads ? leads.filter(l => !['Lost', 'Converted'].includes(l.status)) : leads;

    const handleCreateInZenbooker = async () => { setSyncing(true); try { await contactsApi.createZenbookerCustomer(contact.id); toast.success('Customer created in Zenbooker'); onContactChanged?.(); } catch (err: any) { toast.error(err.message || 'Failed to create customer'); } finally { setSyncing(false); } };
    const handleSyncToZenbooker = async () => { setSyncing(true); try { await contactsApi.syncToZenbooker(contact.id); toast.success('Contact synced to Zenbooker'); onContactChanged?.(); } catch (err: any) { toast.error(err.message || 'Failed to sync'); } finally { setSyncing(false); } };

    if (loading) return <div className="p-4 space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-36" /><Skeleton className="h-4 w-56" /><Skeleton className="h-20 w-full" /></div>;

    return (
        <div className="flex flex-col" style={{ background: '#fff' }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--blanc-line)' }}>
                <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="size-11 rounded-full flex items-center justify-center shrink-0" style={{ background: 'rgba(117,106,89,0.08)', border: '1px solid rgba(117,106,89,0.14)' }}>
                            <User className="size-5" style={{ color: 'var(--blanc-ink-2)' }} />
                        </div>
                        <div className="min-w-0">
                            <h3 className="font-bold text-xl leading-tight truncate" style={{ color: 'var(--blanc-ink-1)' }}>{contact.full_name || 'Unknown'}</h3>
                            {contact.company_name && <p className="text-sm mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{contact.company_name}</p>}
                        </div>
                    </div>
                    <button onClick={() => setEditOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors shrink-0" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)', background: 'var(--blanc-surface-strong)' }}>Edit</button>
                </div>
                <div className="flex items-center gap-2 ml-[56px] text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                    <span className="font-mono">ID: {contact.id}</span>
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status && contact.zenbooker_sync_status !== 'not_linked' && <Badge className="text-[10px] px-1.5 py-0 border-none" style={{ backgroundColor: contact.zenbooker_sync_status === 'linked' ? '#dcfce7' : contact.zenbooker_sync_status === 'pending' ? '#fef3c7' : contact.zenbooker_sync_status === 'error' ? '#fee2e2' : '#f1f5f9', color: contact.zenbooker_sync_status === 'linked' ? '#166534' : contact.zenbooker_sync_status === 'pending' ? '#92400e' : contact.zenbooker_sync_status === 'error' ? '#991b1b' : '#475569' }}>{contact.zenbooker_sync_status === 'linked' ? '● Synced' : contact.zenbooker_sync_status === 'pending' ? '○ Syncing…' : contact.zenbooker_sync_status === 'error' ? '✕ Sync Error' : contact.zenbooker_sync_status}</Badge>}
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status === 'error' && contact.zenbooker_last_error && <span title={contact.zenbooker_last_error} className="cursor-help flex"><AlertCircle className="size-3 text-red-500" /></span>}
                </div>
            </div>

            {/* Two-column grid body */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-0 p-5">
                {/* Left column: Contact Info + Addresses */}
                <div className="space-y-4">
                    <div><h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Contact Information</h4>
                        <div className="space-y-3">
                            <div className="flex items-start gap-3"><Phone className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Phone</Label><div className="flex items-center gap-1"><a href={`tel:${contact.phone_e164}`} className="text-foreground no-underline hover:underline">{formatPhone(contact.phone_e164)}</a><ClickToCallButton phone={contact.phone_e164 || ''} contactName={contact.full_name || undefined} /><OpenTimelineButton phone={contact.phone_e164 || ''} contactId={contact.id} /></div></div></div>
                            <div className="flex items-start gap-3"><Phone className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">{contact.secondary_phone_name ? `Secondary Phone (${contact.secondary_phone_name})` : 'Secondary Phone'}</Label><div className="text-sm font-medium">{contact.secondary_phone ? <div className="flex items-center gap-1"><a href={`tel:${contact.secondary_phone}`} className="text-foreground no-underline hover:underline">{formatPhone(contact.secondary_phone)}</a><ClickToCallButton phone={contact.secondary_phone} contactName={contact.full_name || undefined} /><OpenTimelineButton phone={contact.secondary_phone || ''} contactId={contact.id} /></div> : <span className="text-muted-foreground">—</span>}</div></div></div>
                            <div className="flex items-start gap-3"><Mail className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Email</Label>{contact.email ? <a href={`mailto:${contact.email}`} className="text-sm font-medium text-foreground no-underline hover:underline block">{contact.email}</a> : <div className="text-sm text-muted-foreground">—</div>}</div></div>
                            {contact.zenbooker_id && <div className="flex items-start gap-3"><ExternalLink className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Zenbooker ID</Label><a href={`${ZENBOOKER_BASE_URL}/app?view=customers&customer=${contact.zenbooker_id}`} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-indigo-600 no-underline hover:underline block truncate">{contact.zenbooker_id}</a></div></div>}
                        </div>
                    </div>

                    {ZENBOOKER_SYNC_ENABLED && <div className="flex gap-2">{!contact.zenbooker_customer_id && <button onClick={handleCreateInZenbooker} disabled={syncing} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors"><CloudUpload className="size-3.5" />{syncing ? 'Creating…' : 'Create in Zenbooker'}</button>}{contact.zenbooker_customer_id && <button onClick={handleSyncToZenbooker} disabled={syncing} title={`Push data to Zenbooker${contact.zenbooker_synced_at ? `\nLast synced: ${new Date(contact.zenbooker_synced_at).toLocaleString()}` : ''}`} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border hover:bg-muted disabled:opacity-50 transition-colors"><RefreshCw className="size-3.5" style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />Sync</button>}</div>}

                    <div className="my-3" style={{ borderTop: '1px solid var(--blanc-line)' }} />
                    <div><h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5" style={{ color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}><MapPin className="size-3.5" />Addresses ({contact.addresses.length})</h4>{contact.addresses.length === 0 ? <div className="text-center text-muted-foreground text-sm py-5 bg-muted/30 rounded-lg">No addresses</div> : contact.addresses.map((addr, i) => <AddressCard key={addr.id || i} address={addr} index={i} contactId={contact.id} onSaved={() => onAddressesChanged?.()} />)}</div>
                </div>

                {/* Right column: Notes + Leads + Jobs */}
                <div className="space-y-4">
                    <div><h4 className="text-sm font-semibold mb-3 flex items-center gap-1.5" style={{ color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}><FileText className="size-3.5" />Notes</h4><div className="text-sm whitespace-pre-wrap break-words" style={{ color: contact.notes ? '#111827' : '#cbd5e1' }}>{contact.notes || 'No notes'}</div></div>
                    <div className="my-3" style={{ borderTop: '1px solid var(--blanc-line)' }} />
                    <div>
                        <div className="flex items-center justify-between mb-3"><h4 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--blanc-ink-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}><TrendingUp className="size-3.5" />Leads ({filteredLeads.length})</h4><div className="flex items-center gap-2"><Switch id="pulse-leads-only-open" checked={onlyOpenLeads} onCheckedChange={setOnlyOpenLeads} /><Label htmlFor="pulse-leads-only-open" className="cursor-pointer text-xs">Only Open</Label></div></div>
                        {filteredLeads.length === 0 ? <div className="text-center text-muted-foreground text-sm py-6 bg-muted/30 rounded-lg"><TrendingUp className="size-8 mx-auto mb-2 opacity-20" />{onlyOpenLeads ? 'No open leads for this customer' : 'No leads found'}</div> : (
                            <div className="space-y-2">{filteredLeads.map(lead => (
                                <div key={lead.id} onClick={() => navigate(`/leads/${lead.id}`)} className="p-3 rounded-xl cursor-pointer transition-all" style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)' }} onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(104,95,80,0.3)')} onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--blanc-line)')}>
                                    <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 min-w-0"><div className="size-7 rounded-full flex items-center justify-center shrink-0" style={{ background: 'rgba(117,106,89,0.08)' }}><TrendingUp className="size-3.5" style={{ color: 'var(--blanc-ink-2)' }} /></div><div className="min-w-0"><div className="text-sm font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>{lead.job_type || 'General'}</div><div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{lead.created_at ? format(new Date(lead.created_at), 'MMM dd, yyyy') : '—'}{lead.job_source && ` · ${lead.job_source}`}</div></div></div><div className="flex items-center gap-2 shrink-0"><span className="px-2 py-0.5 rounded-md text-xs font-semibold" style={{ backgroundColor: `${getLeadStatusColor(lead.status)}15`, color: getLeadStatusColor(lead.status) }}>{lead.status}</span><span className="text-xs font-mono" style={{ color: 'var(--blanc-ink-3)' }}>#{lead.serial_id}</span></div></div>
                                    {lead.lead_notes && <div className="text-xs text-muted-foreground mt-2 truncate">{lead.lead_notes}</div>}
                                </div>
                            ))}</div>
                        )}
                    </div>
                    <div className="my-3" style={{ borderTop: '1px solid var(--blanc-line)' }} />
                    <JobsList contactId={contact.id} />
                </div>
            </div>
            {/* Footer timestamps — full width */}
            <div className="text-xs text-muted-foreground flex gap-4 px-5 pb-4 pt-2" style={{ borderTop: '1px solid var(--blanc-line)' }}><span>Created: {contact.created_at ? format(new Date(contact.created_at), 'MMM dd, yyyy HH:mm') : '—'}</span><span>Updated: {contact.updated_at ? format(new Date(contact.updated_at), 'MMM dd, yyyy HH:mm') : '—'}</span></div>
            <EditContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} onSuccess={() => onContactChanged?.()} />
        </div>
    );
}

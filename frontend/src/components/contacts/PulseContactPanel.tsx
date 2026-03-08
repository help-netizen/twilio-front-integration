/**
 * PulseContactPanel — contact detail view styled like LeadDetailPanel
 * for the 400px Pulse middle column.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Mail, ExternalLink, TrendingUp, FileText, User, MapPin, RefreshCw, CloudUpload, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { Skeleton } from '../ui/skeleton';
import { formatPhone } from '../../lib/formatPhone';
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
        <div className="flex flex-col h-full">
            <div className="p-4 border-b">
                <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-3"><div className="size-10 rounded-full bg-indigo-100 flex items-center justify-center shrink-0"><User className="size-5 text-indigo-600" /></div><div><h3 className="font-semibold text-lg leading-tight">{contact.full_name || 'Unknown'}</h3>{contact.company_name && <p className="text-sm text-muted-foreground">{contact.company_name}</p>}</div></div>
                    <button onClick={() => setEditOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-muted transition-colors">Edit</button>
                </div>
                <div className="flex items-center gap-2 ml-[52px] text-xs text-muted-foreground">
                    <span className="font-mono">ID: {contact.id}</span>
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status && contact.zenbooker_sync_status !== 'not_linked' && <Badge className="text-[10px] px-1.5 py-0 border-none" style={{ backgroundColor: contact.zenbooker_sync_status === 'linked' ? '#dcfce7' : contact.zenbooker_sync_status === 'pending' ? '#fef3c7' : contact.zenbooker_sync_status === 'error' ? '#fee2e2' : '#f1f5f9', color: contact.zenbooker_sync_status === 'linked' ? '#166534' : contact.zenbooker_sync_status === 'pending' ? '#92400e' : contact.zenbooker_sync_status === 'error' ? '#991b1b' : '#475569' }}>{contact.zenbooker_sync_status === 'linked' ? '● Synced' : contact.zenbooker_sync_status === 'pending' ? '○ Syncing…' : contact.zenbooker_sync_status === 'error' ? '✕ Sync Error' : contact.zenbooker_sync_status}</Badge>}
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status === 'error' && contact.zenbooker_last_error && <span title={contact.zenbooker_last_error} className="cursor-help flex"><AlertCircle className="size-3 text-red-500" /></span>}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                    <div><h4 className="font-medium mb-3">Contact Information</h4>
                        <div className="space-y-3">
                            <div className="flex items-start gap-3"><Phone className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Phone</Label><div className="flex items-center gap-1"><a href={`tel:${contact.phone_e164}`} className="text-foreground no-underline hover:underline">{formatPhone(contact.phone_e164)}</a><ClickToCallButton phone={contact.phone_e164 || ''} contactName={contact.full_name || undefined} /><OpenTimelineButton phone={contact.phone_e164 || ''} contactId={contact.id} /></div></div></div>
                            <div className="flex items-start gap-3"><Phone className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">{contact.secondary_phone_name ? `Secondary Phone (${contact.secondary_phone_name})` : 'Secondary Phone'}</Label><div className="text-sm font-medium">{contact.secondary_phone ? <div className="flex items-center gap-1"><a href={`tel:${contact.secondary_phone}`} className="text-foreground no-underline hover:underline">{formatPhone(contact.secondary_phone)}</a><ClickToCallButton phone={contact.secondary_phone} contactName={contact.full_name || undefined} /><OpenTimelineButton phone={contact.secondary_phone || ''} contactId={contact.id} /></div> : <span className="text-muted-foreground">—</span>}</div></div></div>
                            <div className="flex items-start gap-3"><Mail className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Email</Label>{contact.email ? <a href={`mailto:${contact.email}`} className="text-sm font-medium text-foreground no-underline hover:underline block">{contact.email}</a> : <div className="text-sm text-muted-foreground">—</div>}</div></div>
                            {contact.zenbooker_id && <div className="flex items-start gap-3"><ExternalLink className="size-4 shrink-0 text-muted-foreground" /><div className="flex-1"><Label className="text-xs text-muted-foreground">Zenbooker ID</Label><a href={`${ZENBOOKER_BASE_URL}/app?view=customers&customer=${contact.zenbooker_id}`} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-indigo-600 no-underline hover:underline block truncate">{contact.zenbooker_id}</a></div></div>}
                        </div>
                    </div>

                    {ZENBOOKER_SYNC_ENABLED && <div className="flex gap-2">{!contact.zenbooker_customer_id && <button onClick={handleCreateInZenbooker} disabled={syncing} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors"><CloudUpload className="size-3.5" />{syncing ? 'Creating…' : 'Create in Zenbooker'}</button>}{contact.zenbooker_customer_id && <button onClick={handleSyncToZenbooker} disabled={syncing} title={`Push data to Zenbooker${contact.zenbooker_synced_at ? `\nLast synced: ${new Date(contact.zenbooker_synced_at).toLocaleString()}` : ''}`} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border hover:bg-muted disabled:opacity-50 transition-colors"><RefreshCw className="size-3.5" style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />Sync</button>}</div>}

                    <Separator />
                    <div><h4 className="font-medium mb-3 flex items-center gap-1.5"><MapPin className="size-4" />Addresses ({contact.addresses.length})</h4>{contact.addresses.length === 0 ? <div className="text-center text-muted-foreground text-sm py-5 bg-muted/30 rounded-lg">No addresses</div> : contact.addresses.map((addr, i) => <AddressCard key={addr.id || i} address={addr} index={i} contactId={contact.id} onSaved={() => onAddressesChanged?.()} />)}</div>
                    <Separator />
                    <div><h4 className="font-medium mb-3 flex items-center gap-1.5"><FileText className="size-4" />Notes</h4><div className="text-sm whitespace-pre-wrap break-words" style={{ color: contact.notes ? '#111827' : '#cbd5e1' }}>{contact.notes || 'No notes'}</div></div>
                    <Separator />
                    <div>
                        <div className="flex items-center justify-between mb-3"><h4 className="font-medium flex items-center gap-1.5"><TrendingUp className="size-4" />Leads ({filteredLeads.length})</h4><div className="flex items-center gap-2"><Switch id="pulse-leads-only-open" checked={onlyOpenLeads} onCheckedChange={setOnlyOpenLeads} /><Label htmlFor="pulse-leads-only-open" className="cursor-pointer text-xs">Only Open</Label></div></div>
                        {filteredLeads.length === 0 ? <div className="text-center text-muted-foreground text-sm py-6 bg-muted/30 rounded-lg"><TrendingUp className="size-8 mx-auto mb-2 opacity-20" />{onlyOpenLeads ? 'No open leads for this customer' : 'No leads found'}</div> : (
                            <div className="space-y-2">{filteredLeads.map(lead => (
                                <div key={lead.id} onClick={() => navigate(`/leads/${lead.id}`)} className="p-3 rounded-lg border bg-white cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all">
                                    <div className="flex items-center justify-between"><div className="flex items-center gap-2"><div className="size-7 rounded-full bg-blue-50 flex items-center justify-center"><TrendingUp className="size-3.5 text-blue-500" /></div><div><div className="text-sm font-medium">{lead.job_type || 'General'}</div><div className="text-xs text-muted-foreground">{lead.created_at ? format(new Date(lead.created_at), 'MMM dd, yyyy') : '—'}{lead.job_source && ` · ${lead.job_source}`}</div></div></div><div className="flex items-center gap-2"><Badge style={{ backgroundColor: `${getLeadStatusColor(lead.status)}15`, color: getLeadStatusColor(lead.status), border: `1px solid ${getLeadStatusColor(lead.status)}30` }}>{lead.status}</Badge><span className="text-xs text-muted-foreground font-mono">#{lead.serial_id}</span></div></div>
                                    {lead.lead_notes && <div className="text-xs text-muted-foreground mt-2 truncate">{lead.lead_notes}</div>}
                                </div>
                            ))}</div>
                        )}
                    </div>
                    <Separator />
                    <JobsList contactId={contact.id} />
                    <div className="text-xs text-muted-foreground flex gap-4 pt-4 border-t"><span>Created: {contact.created_at ? format(new Date(contact.created_at), 'MMM dd, yyyy HH:mm') : '—'}</span><span>Updated: {contact.updated_at ? format(new Date(contact.updated_at), 'MMM dd, yyyy HH:mm') : '—'}</span></div>
                </div>
            </div>
            <EditContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} onSuccess={() => onContactChanged?.()} />
        </div>
    );
}

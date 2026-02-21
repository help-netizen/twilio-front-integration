/**
 * PulseContactPanel — contact detail view styled like LeadDetailPanel
 * for the 400px Pulse middle column.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Phone, Mail, MapPin, ExternalLink, TrendingUp, FileText,
    User, Briefcase, Pencil, Check, X, RefreshCw, CloudUpload, AlertCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { Skeleton } from '../ui/skeleton';
import { formatPhone } from '../../lib/formatPhone';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';
import * as contactsApi from '../../services/contactsApi';
import { EditContactDialog } from './EditContactDialog';
import type { Contact, ContactLead, ContactAddress } from '../../types/contact';

/* ────────────────────────────────────────────────────
   Props
   ──────────────────────────────────────────────────── */

interface PulseContactPanelProps {
    contact: Contact;
    leads: ContactLead[];
    loading: boolean;
    onAddressesChanged?: () => void;
    onContactChanged?: () => void;
}

/* ────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────── */

const ZENBOOKER_BASE_URL = 'https://zenbooker.com';
const ZENBOOKER_JOB_URL = 'https://zenbooker.com/app?view=sched&view-job=';
const ZENBOOKER_SYNC_ENABLED = import.meta.env.VITE_FEATURE_ZENBOOKER_SYNC === 'true';

function getLeadStatusColor(status: string): string {
    switch (status) {
        case 'New':
        case 'Submitted': return '#3b82f6';
        case 'Contacted': return '#8b5cf6';
        case 'Qualified': return '#10b981';
        case 'Proposal Sent': return '#f59e0b';
        case 'Negotiation': return '#f97316';
        case 'Converted': return '#059669';
        case 'Lost': return '#ef4444';
        default: return '#6b7280';
    }
}

function getJobStatusStyle(status: string): { bg: string; color: string } {
    switch (status.toLowerCase()) {
        case 'completed': return { bg: '#dcfce7', color: '#166534' };
        case 'en-route': return { bg: '#dbeafe', color: '#1e40af' };
        case 'started': return { bg: '#fef3c7', color: '#92400e' };
        case 'scheduled': return { bg: '#f3e8ff', color: '#6b21a8' };
        case 'canceled': return { bg: '#fee2e2', color: '#991b1b' };
        default: return { bg: '#f1f5f9', color: '#475569' };
    }
}

/* ────────────────────────────────────────────────────
   Address Card (inline editor)
   ──────────────────────────────────────────────────── */

function AddressCard({ address, index, contactId, onSaved }: {
    address: ContactAddress; index: number; contactId: number; onSaved: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editedAddr, setEditedAddr] = useState<AddressFields>({
        street: address.line1 || '', apt: address.line2 || '',
        city: address.city || '', state: address.state || '',
        zip: address.postal_code || '', lat: address.lat ?? null, lng: address.lng ?? null,
    });

    const startEdit = () => {
        setEditedAddr({
            street: address.line1 || '', apt: address.line2 || '',
            city: address.city || '', state: address.state || '',
            zip: address.postal_code || '', lat: address.lat ?? null, lng: address.lng ?? null,
        });
        setEditing(true);
    };

    const saveEdit = async () => {
        setSaving(true);
        try {
            await contactsApi.updateContactAddress(contactId, Number(address.id), {
                street: editedAddr.street, apt: editedAddr.apt, city: editedAddr.city,
                state: editedAddr.state, zip: editedAddr.zip, lat: editedAddr.lat, lng: editedAddr.lng,
            });
            toast.success('Address updated');
            setEditing(false);
            onSaved();
        } catch {
            toast.error('Failed to update address');
        } finally {
            setSaving(false);
        }
    };

    if (editing) {
        return (
            <div className="rounded-lg border-2 border-indigo-500 bg-indigo-50/30 p-3 mb-2">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold">{address.nickname || `Address ${index + 1}`}</span>
                    <div className="flex gap-1">
                        <button type="button" onClick={saveEdit} disabled={saving}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50">
                            <Check className="size-3" />{saving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" onClick={() => setEditing(false)} disabled={saving}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground border rounded hover:bg-muted disabled:opacity-50">
                            <X className="size-3" />Cancel
                        </button>
                    </div>
                </div>
                <AddressAutocomplete
                    idPrefix={`addr-edit-${index}`}
                    defaultUseDetails={true}
                    value={editedAddr}
                    onChange={setEditedAddr}
                />
            </div>
        );
    }

    const line1 = address.line1 || '';
    const unit = address.line2 ? `, ${address.line2}` : '';
    const cityState = [address.city, address.state ? `${address.state} ${address.postal_code || ''}`.trim() : address.postal_code]
        .filter(Boolean).join(', ');

    return (
        <div className="flex items-start gap-2 rounded-lg border p-3 mb-2 bg-white">
            <MapPin className="size-4 text-indigo-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{line1 + unit || '—'}</div>
                {cityState && <div className="text-xs text-muted-foreground">{cityState}</div>}
            </div>
            {address.is_default_address_for_customer && (
                <Badge variant="secondary" className="text-[10px] shrink-0">Default</Badge>
            )}
            {address.id && (
                <button type="button" onClick={startEdit} title="Edit address"
                    className="p-1 text-muted-foreground hover:text-indigo-600 rounded shrink-0">
                    <Pencil className="size-3.5" />
                </button>
            )}
        </div>
    );
}

/* ────────────────────────────────────────────────────
   Jobs List
   ──────────────────────────────────────────────────── */

function JobsList({ customerId }: { customerId: string | null }) {
    const [jobs, setJobs] = useState<contactsApi.ZenbookerJob[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        if (!customerId) return;
        setLoading(true); setLoaded(false);
        contactsApi.fetchZenbookerJobs(customerId)
            .then(data => { setJobs(data); setLoaded(true); })
            .catch(() => setLoaded(true))
            .finally(() => setLoading(false));
    }, [customerId]);

    if (!customerId) return null;

    return (
        <div>
            <h4 className="font-medium mb-3 flex items-center gap-1.5">
                <Briefcase className="size-4" />
                Jobs {loaded ? `(${jobs.length})` : ''}
            </h4>
            {loading && <div className="text-xs text-muted-foreground py-2">Loading jobs…</div>}
            {loaded && jobs.length === 0 && (
                <div className="text-center text-muted-foreground text-sm py-6 bg-muted/30 rounded-lg">
                    <Briefcase className="size-8 mx-auto mb-2 opacity-20" />
                    No jobs found in Zenbooker
                </div>
            )}
            {jobs.length > 0 && (
                <div className="space-y-2">
                    {jobs.map(job => {
                        const st = getJobStatusStyle(job.status);
                        const date = job.start_date ? new Date(job.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                        return (
                            <a key={job.id} href={`${ZENBOOKER_JOB_URL}${job.id}`} target="_blank" rel="noopener noreferrer"
                                className="flex items-center justify-between p-3 rounded-lg border bg-white no-underline text-inherit hover:border-blue-300 hover:shadow-sm transition-all">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-sm font-medium">{job.service_name || 'Job'}</span>
                                        {job.job_number && <span className="text-xs text-muted-foreground font-mono">#{job.job_number}</span>}
                                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: st.bg, color: st.color }}>
                                            {job.status}
                                        </span>
                                    </div>
                                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                                        {job.assigned_providers.length > 0 && <span>👤 {job.assigned_providers.join(', ')}</span>}
                                        {date && <span>📅 {date}</span>}
                                        {job.invoice_total && <span>💰 ${job.invoice_total}</span>}
                                    </div>
                                </div>
                                <ExternalLink className="size-3.5 text-muted-foreground shrink-0" />
                            </a>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/* ════════════════════════════════════════════════════
   Main Component
   ════════════════════════════════════════════════════ */

export function PulseContactPanel({ contact, leads, loading, onAddressesChanged, onContactChanged }: PulseContactPanelProps) {
    const navigate = useNavigate();
    const [editOpen, setEditOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [onlyOpenLeads, setOnlyOpenLeads] = useState(true);
    const filteredLeads = onlyOpenLeads
        ? leads.filter(l => !['Lost', 'Converted'].includes(l.status))
        : leads;

    const handleCreateInZenbooker = async () => {
        setSyncing(true);
        try {
            await contactsApi.createZenbookerCustomer(contact.id);
            toast.success('Customer created in Zenbooker');
            onContactChanged?.();
        } catch (err: any) { toast.error(err.message || 'Failed to create customer'); }
        finally { setSyncing(false); }
    };

    const handleSyncToZenbooker = async () => {
        setSyncing(true);
        try {
            await contactsApi.syncToZenbooker(contact.id);
            toast.success('Contact synced to Zenbooker');
            onContactChanged?.();
        } catch (err: any) { toast.error(err.message || 'Failed to sync'); }
        finally { setSyncing(false); }
    };

    if (loading) {
        return (
            <div className="p-4 space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-20 w-full" />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* ── Header ── */}
            <div className="p-4 border-b">
                <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-3">
                        <div className="size-10 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                            <User className="size-5 text-indigo-600" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-lg leading-tight">
                                {contact.full_name || 'Unknown'}
                            </h3>
                            {contact.company_name && (
                                <p className="text-sm text-muted-foreground">{contact.company_name}</p>
                            )}
                        </div>
                    </div>
                    <button onClick={() => setEditOpen(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium hover:bg-muted transition-colors">
                        <Pencil className="size-3.5" /> Edit
                    </button>
                </div>
                <div className="flex items-center gap-2 ml-[52px] text-xs text-muted-foreground">
                    <span className="font-mono">ID: {contact.id}</span>
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status && contact.zenbooker_sync_status !== 'not_linked' && (
                        <Badge className="text-[10px] px-1.5 py-0 border-none" style={{
                            backgroundColor: contact.zenbooker_sync_status === 'linked' ? '#dcfce7' :
                                contact.zenbooker_sync_status === 'pending' ? '#fef3c7' :
                                    contact.zenbooker_sync_status === 'error' ? '#fee2e2' : '#f1f5f9',
                            color: contact.zenbooker_sync_status === 'linked' ? '#166534' :
                                contact.zenbooker_sync_status === 'pending' ? '#92400e' :
                                    contact.zenbooker_sync_status === 'error' ? '#991b1b' : '#475569',
                        }}>
                            {contact.zenbooker_sync_status === 'linked' ? '● Synced' :
                                contact.zenbooker_sync_status === 'pending' ? '○ Syncing…' :
                                    contact.zenbooker_sync_status === 'error' ? '✕ Sync Error' : contact.zenbooker_sync_status}
                        </Badge>
                    )}
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status === 'error' && contact.zenbooker_last_error && (
                        <span title={contact.zenbooker_last_error} className="cursor-help flex">
                            <AlertCircle className="size-3 text-red-500" />
                        </span>
                    )}
                </div>
            </div>

            {/* ── Scrollable body ── */}
            <div className="flex-1 overflow-y-auto">
                <div className="p-4 space-y-4">
                    {/* Contact Info */}
                    <div>
                        <h4 className="font-medium mb-3">Contact Information</h4>
                        <div className="space-y-3">
                            {/* Phone */}
                            <div className="flex items-start gap-3">
                                <Phone className="size-4 shrink-0 text-muted-foreground" />
                                <div className="flex-1">
                                    <Label className="text-xs text-muted-foreground">Phone</Label>
                                    <div className="text-sm font-medium">
                                        <a href={`tel:${contact.phone_e164}`} className="text-foreground no-underline hover:underline">
                                            {formatPhone(contact.phone_e164)}
                                        </a>
                                    </div>
                                </div>
                            </div>

                            {/* Secondary Phone */}
                            <div className="flex items-start gap-3">
                                <Phone className="size-4 shrink-0 text-muted-foreground" />
                                <div className="flex-1">
                                    <Label className="text-xs text-muted-foreground">
                                        {contact.secondary_phone_name ? `Secondary Phone (${contact.secondary_phone_name})` : 'Secondary Phone'}
                                    </Label>
                                    <div className="text-sm font-medium">
                                        {contact.secondary_phone ? (
                                            <a href={`tel:${contact.secondary_phone}`} className="text-foreground no-underline hover:underline">
                                                {formatPhone(contact.secondary_phone)}
                                            </a>
                                        ) : <span className="text-muted-foreground">—</span>}
                                    </div>
                                </div>
                            </div>

                            {/* Email */}
                            <div className="flex items-start gap-3">
                                <Mail className="size-4 shrink-0 text-muted-foreground" />
                                <div className="flex-1">
                                    <Label className="text-xs text-muted-foreground">Email</Label>
                                    {contact.email ? (
                                        <a href={`mailto:${contact.email}`} className="text-sm font-medium text-foreground no-underline hover:underline block">
                                            {contact.email}
                                        </a>
                                    ) : <div className="text-sm text-muted-foreground">—</div>}
                                </div>
                            </div>

                            {/* Zenbooker ID */}
                            {contact.zenbooker_id && (
                                <div className="flex items-start gap-3">
                                    <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="flex-1">
                                        <Label className="text-xs text-muted-foreground">Zenbooker ID</Label>
                                        <a href={`${ZENBOOKER_BASE_URL}/app?view=customers&customer=${contact.zenbooker_id}`}
                                            target="_blank" rel="noopener noreferrer"
                                            className="text-sm font-medium text-indigo-600 no-underline hover:underline block truncate">
                                            {contact.zenbooker_id}
                                        </a>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Zenbooker sync buttons */}
                    {ZENBOOKER_SYNC_ENABLED && (
                        <div className="flex gap-2">
                            {!contact.zenbooker_customer_id && (
                                <button onClick={handleCreateInZenbooker} disabled={syncing}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 transition-colors">
                                    <CloudUpload className="size-3.5" />
                                    {syncing ? 'Creating…' : 'Create in Zenbooker'}
                                </button>
                            )}
                            {contact.zenbooker_customer_id && (
                                <button onClick={handleSyncToZenbooker} disabled={syncing}
                                    title={`Push data to Zenbooker${contact.zenbooker_synced_at ? `\nLast synced: ${new Date(contact.zenbooker_synced_at).toLocaleString()}` : ''}`}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border hover:bg-muted disabled:opacity-50 transition-colors">
                                    <RefreshCw className="size-3.5" style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
                                    Sync
                                </button>
                            )}
                        </div>
                    )}

                    <Separator />

                    {/* Addresses */}
                    <div>
                        <h4 className="font-medium mb-3 flex items-center gap-1.5">
                            <MapPin className="size-4" />
                            Addresses ({contact.addresses.length})
                        </h4>
                        {contact.addresses.length === 0 ? (
                            <div className="text-center text-muted-foreground text-sm py-5 bg-muted/30 rounded-lg">
                                No addresses
                            </div>
                        ) : (
                            contact.addresses.map((addr, i) => (
                                <AddressCard key={addr.id || i} address={addr} index={i}
                                    contactId={contact.id} onSaved={() => onAddressesChanged?.()} />
                            ))
                        )}
                    </div>

                    <Separator />

                    {/* Notes */}
                    <div>
                        <h4 className="font-medium mb-3 flex items-center gap-1.5">
                            <FileText className="size-4" />
                            Notes
                        </h4>
                        <div className="text-sm whitespace-pre-wrap break-words" style={{ color: contact.notes ? '#111827' : '#cbd5e1' }}>
                            {contact.notes || 'No notes'}
                        </div>
                    </div>

                    <Separator />

                    {/* Leads */}
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <h4 className="font-medium flex items-center gap-1.5">
                                <TrendingUp className="size-4" />
                                Leads ({filteredLeads.length})
                            </h4>
                            <div className="flex items-center gap-2">
                                <Switch id="pulse-leads-only-open" checked={onlyOpenLeads} onCheckedChange={setOnlyOpenLeads} />
                                <Label htmlFor="pulse-leads-only-open" className="cursor-pointer text-xs">Only Open</Label>
                            </div>
                        </div>

                        {filteredLeads.length === 0 ? (
                            <div className="text-center text-muted-foreground text-sm py-6 bg-muted/30 rounded-lg">
                                <TrendingUp className="size-8 mx-auto mb-2 opacity-20" />
                                {onlyOpenLeads ? 'No open leads for this customer' : 'No leads found'}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {filteredLeads.map(lead => (
                                    <div key={lead.id} onClick={() => navigate(`/leads/${lead.id}`)}
                                        className="p-3 rounded-lg border bg-white cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <div className="size-7 rounded-full bg-blue-50 flex items-center justify-center">
                                                    <TrendingUp className="size-3.5 text-blue-500" />
                                                </div>
                                                <div>
                                                    <div className="text-sm font-medium">{lead.job_type || 'General'}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {lead.created_at ? format(new Date(lead.created_at), 'MMM dd, yyyy') : '—'}
                                                        {lead.job_source && ` · ${lead.job_source}`}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Badge style={{
                                                    backgroundColor: `${getLeadStatusColor(lead.status)}15`,
                                                    color: getLeadStatusColor(lead.status),
                                                    border: `1px solid ${getLeadStatusColor(lead.status)}30`,
                                                }}>
                                                    {lead.status}
                                                </Badge>
                                                <span className="text-xs text-muted-foreground font-mono">#{lead.serial_id}</span>
                                            </div>
                                        </div>
                                        {lead.lead_notes && (
                                            <div className="text-xs text-muted-foreground mt-2 truncate">
                                                {lead.lead_notes}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <Separator />

                    {/* Jobs */}
                    <JobsList customerId={contact.zenbooker_customer_id} />

                    {/* Timestamps */}
                    <div className="text-xs text-muted-foreground flex gap-4 pt-4 border-t">
                        <span>Created: {contact.created_at ? format(new Date(contact.created_at), 'MMM dd, yyyy HH:mm') : '—'}</span>
                        <span>Updated: {contact.updated_at ? format(new Date(contact.updated_at), 'MMM dd, yyyy HH:mm') : '—'}</span>
                    </div>
                </div>
            </div>

            {/* Edit Contact Dialog */}
            <EditContactDialog
                contact={contact}
                open={editOpen}
                onOpenChange={setEditOpen}
                onSuccess={() => onContactChanged?.()}
            />
        </div>
    );
}

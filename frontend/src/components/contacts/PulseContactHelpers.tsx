import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Briefcase, Pencil, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';
import * as contactsApi from '../../services/contactsApi';
import * as jobsApi from '../../services/jobsApi';
import type { ContactAddress } from '../../types/contact';

export function getLeadStatusColor(status: string): string {
    switch (status) {
        case 'New': case 'Submitted': return '#3b82f6';
        case 'Contacted': return '#8b5cf6'; case 'Qualified': return '#10b981';
        case 'Proposal Sent': return '#f59e0b'; case 'Negotiation': return '#f97316';
        case 'Converted': return '#059669'; case 'Lost': return '#ef4444';
        default: return '#6b7280';
    }
}

export function getJobStatusStyle(status: string): { bg: string; color: string } {
    switch (status) {
        case 'Submitted': return { bg: '#dbeafe', color: '#1e40af' };
        case 'Waiting for parts': return { bg: '#fef3c7', color: '#92400e' };
        case 'Follow Up with Client': return { bg: '#f3e8ff', color: '#6b21a8' };
        case 'Visit completed': return { bg: '#dcfce7', color: '#166534' };
        case 'Job is Done': return { bg: '#e5e7eb', color: '#374151' };
        case 'Rescheduled': return { bg: '#ffedd5', color: '#9a3412' };
        case 'Canceled': return { bg: '#fee2e2', color: '#991b1b' };
        default: return { bg: '#f1f5f9', color: '#475569' };
    }
}

export function JobsList({ contactId }: { contactId: number }) {
    const [jobs, setJobs] = useState<jobsApi.LocalJob[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const navigate = useNavigate();

    useEffect(() => { if (!contactId) return; setLoading(true); setLoaded(false); jobsApi.listJobs({ contact_id: contactId, limit: 50 }).then(data => { setJobs(data.results); setLoaded(true); }).catch(() => setLoaded(true)).finally(() => setLoading(false)); }, [contactId]);

    return (
        <div>
            <h4 className="font-medium mb-3 flex items-center gap-1.5"><Briefcase className="size-4" /> Jobs {loaded ? `(${jobs.length})` : ''}</h4>
            {loading && <div className="text-xs text-muted-foreground py-2">Loading jobs…</div>}
            {loaded && jobs.length === 0 && <div className="text-center text-muted-foreground text-sm py-6 bg-muted/30 rounded-lg"><Briefcase className="size-8 mx-auto mb-2 opacity-20" />No jobs found</div>}
            {jobs.length > 0 && (
                <div className="space-y-2">
                    {jobs.map(job => {
                        const st = getJobStatusStyle(job.blanc_status); const date = job.start_date ? new Date(job.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null; return (
                            <div key={job.id} onClick={() => navigate(`/jobs/${job.id}`)} className="flex items-center justify-between p-3 rounded-lg border bg-white cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all">
                                <div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap"><span className="text-sm font-medium">{job.service_name || 'Job'}</span>{job.job_number && <span className="text-xs text-muted-foreground font-mono">#{job.job_number}</span>}<span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: st.bg, color: st.color }}>{job.blanc_status}</span></div><div className="flex gap-3 mt-1 text-xs text-muted-foreground">{job.assigned_techs && job.assigned_techs.length > 0 && <span>👤 {job.assigned_techs.map((p: any) => p.name).join(', ')}</span>}{date && <span>📅 {date}</span>}{job.invoice_total && <span>💰 ${job.invoice_total}</span>}</div></div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function AddressCard({ address, index, contactId, onSaved }: { address: ContactAddress; index: number; contactId: number; onSaved: () => void; }) {
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editedAddr, setEditedAddr] = useState<AddressFields>({ street: address.line1 || '', apt: address.line2 || '', city: address.city || '', state: address.state || '', zip: address.postal_code || '', lat: address.lat ?? null, lng: address.lng ?? null });

    const startEdit = () => { setEditedAddr({ street: address.line1 || '', apt: address.line2 || '', city: address.city || '', state: address.state || '', zip: address.postal_code || '', lat: address.lat ?? null, lng: address.lng ?? null }); setEditing(true); };
    const saveEdit = async () => { setSaving(true); try { await contactsApi.updateContactAddress(contactId, Number(address.id), { street: editedAddr.street, apt: editedAddr.apt, city: editedAddr.city, state: editedAddr.state, zip: editedAddr.zip, lat: editedAddr.lat, lng: editedAddr.lng }); toast.success('Address updated'); setEditing(false); onSaved(); } catch { toast.error('Failed to update address'); } finally { setSaving(false); } };

    if (editing) return (
        <div className="rounded-lg border-2 border-indigo-500 bg-indigo-50/30 p-3 mb-2">
            <div className="flex items-center justify-between mb-2"><span className="text-xs font-semibold">{address.nickname || `Address ${index + 1}`}</span><div className="flex gap-1"><button type="button" onClick={saveEdit} disabled={saving} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"><Check className="size-3" />{saving ? 'Saving…' : 'Save'}</button><button type="button" onClick={() => setEditing(false)} disabled={saving} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-muted-foreground border rounded hover:bg-muted disabled:opacity-50"><X className="size-3" />Cancel</button></div></div>
            <AddressAutocomplete idPrefix={`addr-edit-${index}`} defaultUseDetails={true} value={editedAddr} onChange={setEditedAddr} />
        </div>
    );

    const line1 = address.line1 || ''; const unit = address.line2 ? `, ${address.line2}` : '';
    const cityState = [address.city, address.state ? `${address.state} ${address.postal_code || ''}`.trim() : address.postal_code].filter(Boolean).join(', ');

    return (
        <div className="flex items-start gap-2 rounded-lg border p-3 mb-2 bg-white">
            <MapPin className="size-4 text-indigo-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0"><div className="text-sm font-medium">{line1 + unit || '—'}</div>{cityState && <div className="text-xs text-muted-foreground">{cityState}</div>}</div>
            {address.is_default_address_for_customer && <Badge variant="secondary" className="text-[10px] shrink-0">Default</Badge>}
            {address.id && <button type="button" onClick={startEdit} title="Edit address" className="p-1 text-muted-foreground hover:text-indigo-600 rounded shrink-0"><Pencil className="size-3.5" /></button>}
        </div>
    );
}

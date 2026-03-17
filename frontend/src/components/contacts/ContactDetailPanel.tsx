import { useState } from 'react';
import { Phone, Mail, ExternalLink, Activity, TrendingUp, FileText, User, MapPin, Briefcase, Pencil, RefreshCw, CloudUpload, AlertCircle } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { Contact, ContactLead } from '../../types/contact';
import * as contactsApi from '../../services/contactsApi';
import { pulseApi } from '../../services/pulseApi';
import { EditContactDialog } from './EditContactDialog';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { contactDetailStyles, InfoRow, formatPhone, getLeadStatusColor } from './contactDetailHelpers';
import { JobsList } from './ContactJobsList';
import { AddressCard } from './AddressCard';

interface ContactDetailPanelProps {
    contact: Contact;
    leads: ContactLead[];
    loading: boolean;
    onAddressesChanged?: () => void;
    onContactChanged?: () => void;
}

const ZENBOOKER_BASE_URL = 'https://zenbooker.com';
const ZENBOOKER_SYNC_ENABLED = import.meta.env.VITE_FEATURE_ZENBOOKER_SYNC === 'true';

export function ContactDetailPanel({ contact, leads, loading, onAddressesChanged, onContactChanged }: ContactDetailPanelProps) {
    const navigate = useNavigate();
    const [editOpen, setEditOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [onlyOpenLeads, setOnlyOpenLeads] = useState(true);
    const filteredLeads = onlyOpenLeads ? leads.filter(l => !['Lost', 'Converted'].includes(l.status)) : leads;

    const handleCreateInZenbooker = async () => {
        setSyncing(true);
        try { await contactsApi.createZenbookerCustomer(contact.id); toast.success('Customer created in Zenbooker'); onContactChanged?.(); }
        catch (err: any) { toast.error(err.message || 'Failed to create customer'); }
        finally { setSyncing(false); }
    };

    const handleSyncToZenbooker = async () => {
        setSyncing(true);
        try { await contactsApi.syncToZenbooker(contact.id); toast.success('Contact synced to Zenbooker'); onContactChanged?.(); }
        catch (err: any) { toast.error(err.message || 'Failed to sync'); }
        finally { setSyncing(false); }
    };

    if (loading) {
        return (
            <div style={{ padding: '24px' }}>
                <Skeleton className="h-8 w-64 mb-4" /><Skeleton className="h-4 w-48 mb-2" />
                <Skeleton className="h-4 w-56 mb-6" /><Skeleton className="h-24 w-full mb-4" /><Skeleton className="h-24 w-full" />
            </div>
        );
    }

    return (
        <div style={{ padding: '24px', maxWidth: '800px', overflowY: 'auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ width: '48px', height: '48px', borderRadius: '50%', backgroundColor: '#e0e7ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <User style={{ width: '24px', height: '24px', color: '#4f46e5' }} />
                    </div>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 600, color: '#111827' }}>{contact.full_name || 'Unknown'}</h2>
                            <button onClick={async () => { if (contact.phone_e164) { try { const result = await pulseApi.ensureTimeline(contact.phone_e164, contact.id); if (result.timelineId) { navigate(`/pulse/timeline/${result.timelineId}`); return; } } catch (err) { console.error('Failed to resolve timeline:', err); } } navigate('/pulse'); }} title="View in Pulse" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: '4px', color: '#6b7280', display: 'flex', alignItems: 'center' }}>
                                <Activity style={{ width: '18px', height: '18px' }} />
                            </button>
                        </div>
                        <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            Contact ID: {contact.id}
                            {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status && contact.zenbooker_sync_status !== 'not_linked' && (
                                <Badge style={{ fontSize: '10px', padding: '1px 6px', backgroundColor: contact.zenbooker_sync_status === 'linked' ? '#dcfce7' : contact.zenbooker_sync_status === 'pending' ? '#fef3c7' : contact.zenbooker_sync_status === 'error' ? '#fee2e2' : '#f1f5f9', color: contact.zenbooker_sync_status === 'linked' ? '#166534' : contact.zenbooker_sync_status === 'pending' ? '#92400e' : contact.zenbooker_sync_status === 'error' ? '#991b1b' : '#475569', border: 'none' }} title={contact.zenbooker_last_error || undefined}>
                                    {contact.zenbooker_sync_status === 'linked' ? '● Synced' : contact.zenbooker_sync_status === 'pending' ? '○ Syncing…' : contact.zenbooker_sync_status === 'error' ? '✕ Sync Error' : contact.zenbooker_sync_status}
                                </Badge>
                            )}
                            {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_sync_status === 'error' && contact.zenbooker_last_error && (
                                <span title={contact.zenbooker_last_error} style={{ cursor: 'help', display: 'flex' }}><AlertCircle style={{ width: '13px', height: '13px', color: '#ef4444' }} /></span>
                            )}
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button onClick={() => setEditOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: '#fff', color: '#374151', fontSize: '13px', fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s' }}>
                        <Pencil style={{ width: '14px', height: '14px' }} />Edit
                    </button>
                    {ZENBOOKER_SYNC_ENABLED && !contact.zenbooker_customer_id && (
                        <button onClick={handleCreateInZenbooker} disabled={syncing} title="Create this contact as a customer in Zenbooker" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', borderRadius: '8px', border: '1px solid #6366f1', backgroundColor: '#eef2ff', color: '#4338ca', fontSize: '13px', fontWeight: 500, cursor: syncing ? 'wait' : 'pointer', opacity: syncing ? 0.6 : 1, transition: 'all 0.15s' }}>
                            <CloudUpload style={{ width: '14px', height: '14px' }} />{syncing ? 'Creating…' : 'Create in Zenbooker'}
                        </button>
                    )}
                    {ZENBOOKER_SYNC_ENABLED && contact.zenbooker_customer_id && (
                        <button onClick={handleSyncToZenbooker} disabled={syncing} title={`Push data from this contact to Zenbooker.${contact.zenbooker_synced_at ? `\nLast synced: ${new Date(contact.zenbooker_synced_at).toLocaleString()}` : ''}`} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 10px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: '#fff', color: '#374151', fontSize: '13px', fontWeight: 500, cursor: syncing ? 'wait' : 'pointer', opacity: syncing ? 0.6 : 1, transition: 'all 0.15s' }}>
                            <RefreshCw style={{ width: '14px', height: '14px', animation: syncing ? 'spin 1s linear infinite' : 'none' }} />Sync
                        </button>
                    )}
                </div>
            </div>

            {/* Contact Info */}
            <div style={{ backgroundColor: '#f8fafc', borderRadius: '12px', padding: '16px 20px', marginBottom: '24px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 0' }} className="click-to-call-row">
                        <div style={{ color: '#94a3b8', marginTop: '1px', flexShrink: 0 }}><Phone style={{ width: '14px', height: '14px' }} /></div>
                        <div style={{ minWidth: 0 }}>
                            <div style={contactDetailStyles.labelStyle}>Phone</div>
                            <div style={{ fontSize: '14px', color: contact.phone_e164 ? '#111827' : '#cbd5e1', fontWeight: contact.phone_e164 ? 500 : 400, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                {formatPhone(contact.phone_e164) || '—'}
                                {contact.phone_e164 && <ClickToCallButton phone={contact.phone_e164} contactName={contact.full_name || undefined} />}
                                {contact.phone_e164 && <OpenTimelineButton phone={contact.phone_e164} contactId={contact.id} />}
                            </div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 0' }} className="click-to-call-row">
                        <div style={{ color: '#94a3b8', marginTop: '1px', flexShrink: 0 }}><Phone style={{ width: '14px', height: '14px' }} /></div>
                        <div style={{ minWidth: 0 }}>
                            <div style={contactDetailStyles.labelStyle}>{contact.secondary_phone_name ? `Secondary Phone (${contact.secondary_phone_name})` : 'Secondary Phone'}</div>
                            <div style={{ fontSize: '14px', color: contact.secondary_phone ? '#111827' : '#cbd5e1', fontWeight: contact.secondary_phone ? 500 : 400, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                {formatPhone(contact.secondary_phone) || '—'}
                                {contact.secondary_phone && <ClickToCallButton phone={contact.secondary_phone} contactName={contact.full_name || undefined} />}
                                {contact.secondary_phone && <OpenTimelineButton phone={contact.secondary_phone} contactId={contact.id} />}
                            </div>
                        </div>
                    </div>
                    <InfoRow label="Email" value={contact.email || ''} icon={<Mail style={{ width: '14px', height: '14px' }} />} />
                    {contact.zenbooker_id ? (
                        <div style={{ marginBottom: '4px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <ExternalLink style={{ width: '14px', height: '14px' }} />Zenbooker ID
                            </div>
                            <a href={`${ZENBOOKER_BASE_URL}/app?view=customers&customer=${contact.zenbooker_id}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '14px', color: '#6366f1', textDecoration: 'none' }} onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')} onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>{contact.zenbooker_id}</a>
                        </div>
                    ) : <div />}
                    {contact.company_name && (
                        <div style={{ gridColumn: '1 / -1' }}>
                            <InfoRow label="Company" value={contact.company_name} icon={<Briefcase style={{ width: '14px', height: '14px' }} />} />
                        </div>
                    )}
                </div>
            </div>

            {/* Addresses */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={contactDetailStyles.sectionTitleStyle}><MapPin style={{ width: '16px', height: '16px' }} />Addresses ({contact.addresses.length})</h3>
                {contact.addresses.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#94a3b8', fontSize: '13px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>No addresses</div>
                ) : (
                    contact.addresses.map((addr, i) => <AddressCard key={addr.id || i} address={addr} index={i} contactId={contact.id} onSaved={() => onAddressesChanged?.()} />)
                )}
            </div>

            {/* Notes */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={contactDetailStyles.sectionTitleStyle}><FileText style={{ width: '16px', height: '16px' }} />Notes</h3>
                <div style={{ fontSize: '14px', color: contact.notes ? '#111827' : '#cbd5e1', fontWeight: 400, lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{contact.notes || 'No notes'}</div>
            </div>

            {/* Leads */}
            <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h3 style={contactDetailStyles.sectionTitleStyle}><TrendingUp style={{ width: '16px', height: '16px' }} />Leads ({onlyOpenLeads ? filteredLeads.length : leads.length})</h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Switch id="leads-only-open" checked={onlyOpenLeads} onCheckedChange={setOnlyOpenLeads} />
                        <Label htmlFor="leads-only-open" style={{ cursor: 'pointer', fontSize: '13px' }}>Only Open</Label>
                    </div>
                </div>
                {filteredLeads.length === 0 ? (
                    <div style={{ padding: '32px', textAlign: 'center', color: '#94a3b8', fontSize: '14px', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
                        <TrendingUp style={{ width: '32px', height: '32px', margin: '0 auto 8px', opacity: 0.3 }} />
                        {onlyOpenLeads ? 'No open leads for this customer' : 'No leads found for this customer'}
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {filteredLeads.map((lead) => (
                            <div key={lead.id} onClick={() => navigate(`/leads/${lead.id}`)} style={{ padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', cursor: 'pointer', transition: 'all 0.15s', backgroundColor: '#fff' }}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#93c5fd'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(59,130,246,0.1)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = 'none'; }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', backgroundColor: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <TrendingUp style={{ width: '14px', height: '14px', color: '#3b82f6' }} />
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>{lead.job_type || 'General'}</div>
                                            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>{lead.created_at ? format(new Date(lead.created_at), 'MMM dd, yyyy') : '—'}{lead.job_source && ` · ${lead.job_source}`}</div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <Badge style={{ backgroundColor: `${getLeadStatusColor(lead.status)}15`, color: getLeadStatusColor(lead.status), border: `1px solid ${getLeadStatusColor(lead.status)}30` }}>{lead.status}</Badge>
                                        <span style={{ fontSize: '12px', color: '#9ca3af', fontFamily: 'monospace' }}>#{lead.serial_id}</span>
                                    </div>
                                </div>
                                {lead.lead_notes && <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.lead_notes}</div>}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Jobs */}
            <div style={{ marginTop: '24px' }}><JobsList contactId={contact.id} /></div>

            {/* Timestamps */}
            <div style={{ marginTop: '32px', paddingTop: '16px', borderTop: '1px solid #f1f5f9', fontSize: '12px', color: '#9ca3af', display: 'flex', gap: '24px' }}>
                <span>Created: {contact.created_at ? format(new Date(contact.created_at), 'MMM dd, yyyy HH:mm') : '—'}</span>
                <span>Updated: {contact.updated_at ? format(new Date(contact.updated_at), 'MMM dd, yyyy HH:mm') : '—'}</span>
            </div>

            <EditContactDialog contact={contact} open={editOpen} onOpenChange={setEditOpen} onSuccess={() => onContactChanged?.()} />
        </div>
    );
}

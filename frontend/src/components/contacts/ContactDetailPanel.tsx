import { useState } from 'react';
import { Phone, Mail, ExternalLink, Activity, TrendingUp, FileText, User, MapPin, CreditCard, Briefcase, CalendarClock, Pencil, Check, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Skeleton } from '../ui/skeleton';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { Contact, ContactLead, ContactAddress } from '../../types/contact';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';
import * as contactsApi from '../../services/contactsApi';
import { EditContactDialog } from './EditContactDialog';

interface ContactDetailPanelProps {
    contact: Contact;
    leads: ContactLead[];
    loading: boolean;
    onAddressesChanged?: () => void;
    onContactChanged?: () => void;
}

const ZENBOOKER_BASE_URL = 'https://app.zenbooker.com';

function formatPhone(phone: string | null): string {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
}

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

const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
};

const sectionTitleStyle: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 600,
    color: '#374151',
    marginBottom: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
};

function InfoRow({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 0' }}>
            {icon && (
                <div style={{ color: '#94a3b8', marginTop: '1px', flexShrink: 0 }}>
                    {icon}
                </div>
            )}
            <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{label}</div>
                <div style={{
                    fontSize: '14px', color: value ? '#111827' : '#cbd5e1',
                    fontWeight: value ? 500 : 400, wordBreak: 'break-word',
                }}>
                    {value || '—'}
                </div>
            </div>
        </div>
    );
}

function formatAddress(address: ContactAddress): { line1: string; line2: string } {
    const street = address.line1 || '';
    const unit = address.line2 ? `, ${address.line2}` : '';
    const cityState = [
        address.city,
        address.state ? `${address.state} ${address.postal_code || ''}`.trim() : address.postal_code,
    ].filter(Boolean).join(', ');
    return { line1: street + unit, line2: cityState };
}

function AddressCard({ address, index, contactId, onSaved }: {
    address: ContactAddress; index: number; contactId: number;
    onSaved: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editedAddr, setEditedAddr] = useState<AddressFields>({
        street: address.line1 || '',
        apt: address.line2 || '',
        city: address.city || '',
        state: address.state || '',
        zip: address.postal_code || '',
        lat: address.lat ?? null,
        lng: address.lng ?? null,
    });

    const startEdit = () => {
        setEditedAddr({
            street: address.line1 || '',
            apt: address.line2 || '',
            city: address.city || '',
            state: address.state || '',
            zip: address.postal_code || '',
            lat: address.lat ?? null,
            lng: address.lng ?? null,
        });
        setEditing(true);
    };

    const cancelEdit = () => setEditing(false);

    const saveEdit = async () => {
        setSaving(true);
        try {
            const addrId = Number(address.id);
            await contactsApi.updateContactAddress(contactId, addrId, {
                street: editedAddr.street,
                apt: editedAddr.apt,
                city: editedAddr.city,
                state: editedAddr.state,
                zip: editedAddr.zip,
                lat: editedAddr.lat,
                lng: editedAddr.lng,
            });
            toast.success('Address updated');
            setEditing(false);
            onSaved();
        } catch (err) {
            toast.error('Failed to update address');
        } finally {
            setSaving(false);
        }
    };

    if (editing) {
        return (
            <div style={{
                border: '2px solid #6366f1',
                borderRadius: '10px',
                padding: '12px 16px',
                backgroundColor: '#fafbff',
                marginBottom: '8px',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                        {address.nickname || `Address ${index + 1}`}
                    </span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                            type="button"
                            onClick={saveEdit}
                            disabled={saving}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '4px',
                                padding: '4px 10px', borderRadius: '6px',
                                border: 'none', backgroundColor: '#4f46e5', color: '#fff',
                                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                                opacity: saving ? 0.6 : 1,
                            }}
                        >
                            <Check style={{ width: '14px', height: '14px' }} />
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                            type="button"
                            onClick={cancelEdit}
                            disabled={saving}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '4px',
                                padding: '4px 10px', borderRadius: '6px',
                                border: '1px solid #d1d5db', backgroundColor: '#fff', color: '#6b7280',
                                fontSize: '12px', fontWeight: 500, cursor: 'pointer',
                            }}
                        >
                            <X style={{ width: '14px', height: '14px' }} />
                            Cancel
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

    const { line1, line2 } = formatAddress(address);
    return (
        <div style={{
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '12px 16px',
            backgroundColor: '#fff',
            marginBottom: '8px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
        }}>
            <MapPin style={{ width: '16px', height: '16px', color: '#6366f1', marginTop: '2px', flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>
                        {address.nickname || `Address ${index + 1}`}
                    </span>
                    {address.is_default_address_for_customer && (
                        <Badge variant="secondary" style={{ fontSize: '10px' }}>Default</Badge>
                    )}
                </div>
                <div style={{ fontSize: '14px', color: '#111827', fontWeight: 500, lineHeight: '1.5' }}>
                    {line1 || '—'}
                </div>
                {line2 && (
                    <div style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.5' }}>
                        {line2}
                    </div>
                )}
            </div>
            {/* Edit button — only for local addresses (have numeric id) */}
            {address.id && (
                <button
                    type="button"
                    onClick={startEdit}
                    title="Edit address"
                    style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
                        color: '#94a3b8', borderRadius: '4px', flexShrink: 0, marginTop: '2px',
                        transition: 'color 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#4f46e5')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
                >
                    <Pencil style={{ width: '14px', height: '14px' }} />
                </button>
            )}
        </div>
    );
}

export function ContactDetailPanel({ contact, leads, loading, onAddressesChanged, onContactChanged }: ContactDetailPanelProps) {
    const navigate = useNavigate();
    const [editOpen, setEditOpen] = useState(false);

    if (loading) {
        return (
            <div style={{ padding: '24px' }}>
                <Skeleton className="h-8 w-64 mb-4" />
                <Skeleton className="h-4 w-48 mb-2" />
                <Skeleton className="h-4 w-56 mb-6" />
                <Skeleton className="h-24 w-full mb-4" />
                <Skeleton className="h-24 w-full" />
            </div>
        );
    }

    return (
        <div style={{ padding: '24px', maxWidth: '800px', overflowY: 'auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{
                        width: '48px', height: '48px', borderRadius: '50%',
                        backgroundColor: '#e0e7ff', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', flexShrink: 0,
                    }}>
                        <User style={{ width: '24px', height: '24px', color: '#4f46e5' }} />
                    </div>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 600, color: '#111827' }}>
                                {contact.full_name || 'Unknown'}
                            </h2>
                            <button
                                onClick={() => navigate(`/pulse/contact/${contact.id}`)}
                                title="View in Pulse"
                                style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    padding: '4px', borderRadius: '4px', color: '#6b7280',
                                    display: 'flex', alignItems: 'center',
                                }}
                            >
                                <Activity style={{ width: '18px', height: '18px' }} />
                            </button>
                        </div>
                        <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '2px' }}>
                            Contact ID: {contact.id}
                            {contact.zenbooker_id && ` · Zenbooker ID: ${contact.zenbooker_id}`}
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button
                        onClick={() => setEditOpen(true)}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '6px',
                            padding: '8px 14px', borderRadius: '8px', border: '1px solid #d1d5db',
                            backgroundColor: '#fff', color: '#374151', fontSize: '13px',
                            fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s',
                        }}
                    >
                        <Pencil style={{ width: '14px', height: '14px' }} />
                        Edit
                    </button>
                    {contact.zenbooker_customer_id && (
                        <a
                            href={`${ZENBOOKER_BASE_URL}/customers/${contact.zenbooker_customer_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open in Zenbooker"
                            style={{
                                display: 'flex', alignItems: 'center', gap: '6px',
                                padding: '8px 12px', borderRadius: '8px', border: '1px solid #d1d5db',
                                backgroundColor: '#fff', color: '#374151', fontSize: '13px',
                                fontWeight: 500, textDecoration: 'none', transition: 'all 0.15s',
                            }}
                        >
                            Zenbooker
                            <ExternalLink style={{ width: '14px', height: '14px' }} />
                        </a>
                    )}
                </div>
            </div>

            {/* Contact Info */}
            <div style={{
                backgroundColor: '#f8fafc', borderRadius: '12px',
                padding: '16px 20px', marginBottom: '24px',
            }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px' }}>
                    <InfoRow label="Phone" value={formatPhone(contact.phone_e164)} icon={<Phone style={{ width: '14px', height: '14px' }} />} />
                    <InfoRow label="Secondary Phone" value={formatPhone(contact.secondary_phone)} icon={<Phone style={{ width: '14px', height: '14px' }} />} />
                    <div style={{ gridColumn: '1 / -1' }}>
                        <InfoRow label="Email" value={contact.email || ''} icon={<Mail style={{ width: '14px', height: '14px' }} />} />
                    </div>
                    {contact.company_name && (
                        <div style={{ gridColumn: '1 / -1' }}>
                            <InfoRow label="Company" value={contact.company_name} icon={<Briefcase style={{ width: '14px', height: '14px' }} />} />
                        </div>
                    )}
                </div>
            </div>

            {/* Addresses */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={sectionTitleStyle}>
                    <MapPin style={{ width: '16px', height: '16px' }} />
                    Addresses ({contact.addresses.length})
                </h3>
                {contact.addresses.length === 0 ? (
                    <div style={{
                        padding: '20px', textAlign: 'center', color: '#94a3b8',
                        fontSize: '13px', backgroundColor: '#f8fafc', borderRadius: '8px',
                    }}>
                        No addresses
                    </div>
                ) : (
                    contact.addresses.map((addr, i) => (
                        <AddressCard
                            key={addr.id || i}
                            address={addr}
                            index={i}
                            contactId={contact.id}
                            onSaved={() => onAddressesChanged?.()}
                        />
                    ))
                )}
            </div>

            {/* Zenbooker Data */}
            <div style={{
                backgroundColor: '#f8fafc', borderRadius: '12px',
                padding: '16px 20px', marginBottom: '24px',
            }}>
                <h3 style={{ ...sectionTitleStyle, marginBottom: '12px' }}>
                    <Briefcase style={{ width: '16px', height: '16px' }} />
                    Zenbooker Details
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 24px' }}>
                    <InfoRow label="Zenbooker Customer ID" value={contact.zenbooker_customer_id || ''} />
                    <InfoRow label="Stripe Customer ID" value={contact.stripe_customer_id || ''} icon={<CreditCard style={{ width: '14px', height: '14px' }} />} />
                    <InfoRow label="Zenbooker Creation Date" value={contact.zenbooker_creation_date || ''} icon={<CalendarClock style={{ width: '14px', height: '14px' }} />} />
                </div>

                {/* Jobs */}
                <div style={{ marginTop: '16px' }}>
                    <div style={labelStyle}>Jobs ({contact.jobs.length})</div>
                    {contact.jobs.length === 0 ? (
                        <div style={{ fontSize: '13px', color: '#cbd5e1', marginTop: '4px' }}>No jobs</div>
                    ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                            {contact.jobs.map((job, i) => (
                                <Badge key={i} variant="secondary">{job}</Badge>
                            ))}
                        </div>
                    )}
                </div>

                {/* Recurring Bookings */}
                <div style={{ marginTop: '12px' }}>
                    <div style={labelStyle}>Recurring Bookings ({contact.recurring_bookings.length})</div>
                    {contact.recurring_bookings.length === 0 ? (
                        <div style={{ fontSize: '13px', color: '#cbd5e1', marginTop: '4px' }}>No recurring bookings</div>
                    ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                            {contact.recurring_bookings.map((rb, i) => (
                                <Badge key={i} variant="secondary">{rb}</Badge>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Notes */}
            <div style={{ marginBottom: '24px' }}>
                <h3 style={sectionTitleStyle}>
                    <FileText style={{ width: '16px', height: '16px' }} />
                    Notes
                </h3>
                <div style={{
                    fontSize: '14px', color: contact.notes ? '#111827' : '#cbd5e1',
                    fontWeight: contact.notes ? 400 : 400, lineHeight: '1.6',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                    {contact.notes || 'No notes'}
                </div>
            </div>

            {/* Leads Section */}
            <div>
                <h3 style={sectionTitleStyle}>
                    <TrendingUp style={{ width: '16px', height: '16px' }} />
                    Leads ({leads.length})
                </h3>

                {leads.length === 0 ? (
                    <div style={{
                        padding: '32px', textAlign: 'center', color: '#94a3b8',
                        fontSize: '14px', backgroundColor: '#f8fafc', borderRadius: '8px',
                    }}>
                        <TrendingUp style={{ width: '32px', height: '32px', margin: '0 auto 8px', opacity: 0.3 }} />
                        No leads found for this customer
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {leads.map((lead) => (
                            <div
                                key={lead.id}
                                onClick={() => navigate(`/leads/${lead.id}`)}
                                style={{
                                    padding: '12px 16px', border: '1px solid #e5e7eb',
                                    borderRadius: '10px', cursor: 'pointer',
                                    transition: 'all 0.15s', backgroundColor: '#fff',
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.borderColor = '#93c5fd';
                                    e.currentTarget.style.boxShadow = '0 1px 4px rgba(59,130,246,0.1)';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.borderColor = '#e5e7eb';
                                    e.currentTarget.style.boxShadow = 'none';
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <div style={{
                                            width: '28px', height: '28px', borderRadius: '50%',
                                            backgroundColor: '#dbeafe', display: 'flex',
                                            alignItems: 'center', justifyContent: 'center',
                                        }}>
                                            <TrendingUp style={{ width: '14px', height: '14px', color: '#3b82f6' }} />
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>
                                                {lead.job_type || 'General'}
                                            </div>
                                            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>
                                                {lead.created_at ? format(new Date(lead.created_at), 'MMM dd, yyyy') : '—'}
                                                {lead.job_source && ` · ${lead.job_source}`}
                                            </div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <Badge
                                            style={{
                                                backgroundColor: `${getLeadStatusColor(lead.status)}15`,
                                                color: getLeadStatusColor(lead.status),
                                                border: `1px solid ${getLeadStatusColor(lead.status)}30`,
                                            }}
                                        >
                                            {lead.status}
                                        </Badge>
                                        <span style={{ fontSize: '12px', color: '#9ca3af', fontFamily: 'monospace' }}>
                                            #{lead.serial_id}
                                        </span>
                                    </div>
                                </div>
                                {lead.lead_notes && (
                                    <div style={{
                                        fontSize: '13px', color: '#6b7280', marginTop: '8px',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}>
                                        {lead.lead_notes}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Timestamps */}
            <div style={{
                marginTop: '32px', paddingTop: '16px', borderTop: '1px solid #f1f5f9',
                fontSize: '12px', color: '#9ca3af', display: 'flex', gap: '24px',
            }}>
                <span>Created: {contact.created_at ? format(new Date(contact.created_at), 'MMM dd, yyyy HH:mm') : '—'}</span>
                <span>Updated: {contact.updated_at ? format(new Date(contact.updated_at), 'MMM dd, yyyy HH:mm') : '—'}</span>
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

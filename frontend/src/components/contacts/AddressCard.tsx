import { useState } from 'react';
import { MapPin, Pencil, Check, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { toast } from 'sonner';
import type { ContactAddress } from '../../types/contact';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';
import * as contactsApi from '../../services/contactsApi';

function formatAddress(address: ContactAddress): { line1: string; line2: string } {
    const street = address.line1 || '';
    const unit = address.line2 ? `, ${address.line2}` : '';
    const cityState = [
        address.city,
        address.state ? `${address.state} ${address.postal_code || ''}`.trim() : address.postal_code,
    ].filter(Boolean).join(', ');
    return { line1: street + unit, line2: cityState };
}

export function AddressCard({ address, index, contactId, onSaved }: {
    address: ContactAddress; index: number; contactId: number;
    onSaved: () => void;
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

    const cancelEdit = () => setEditing(false);

    const saveEdit = async () => {
        setSaving(true);
        try {
            const addrId = Number(address.id);
            await contactsApi.updateContactAddress(contactId, addrId, {
                street: editedAddr.street, apt: editedAddr.apt, city: editedAddr.city,
                state: editedAddr.state, zip: editedAddr.zip, lat: editedAddr.lat, lng: editedAddr.lng,
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
            <div style={{ border: '2px solid #6366f1', borderRadius: '10px', padding: '12px 16px', backgroundColor: '#fafbff', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>{address.nickname || `Address ${index + 1}`}</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button type="button" onClick={saveEdit} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '6px', border: 'none', backgroundColor: '#4f46e5', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
                            <Check style={{ width: '14px', height: '14px' }} />{saving ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" onClick={cancelEdit} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '6px', border: '1px solid #d1d5db', backgroundColor: '#fff', color: '#6b7280', fontSize: '12px', fontWeight: 500, cursor: 'pointer' }}>
                            <X style={{ width: '14px', height: '14px' }} />Cancel
                        </button>
                    </div>
                </div>
                <AddressAutocomplete idPrefix={`addr-edit-${index}`} defaultUseDetails={true} value={editedAddr} onChange={setEditedAddr} />
            </div>
        );
    }

    const { line1, line2 } = formatAddress(address);
    return (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px 16px', backgroundColor: '#fff', marginBottom: '8px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            <MapPin style={{ width: '16px', height: '16px', color: '#6366f1', marginTop: '2px', flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', color: '#111827', fontWeight: 500, lineHeight: '1.5' }}>{line1 || '—'}</div>
                    {line2 && <div style={{ fontSize: '13px', color: '#6b7280', lineHeight: '1.5' }}>{line2}</div>}
                </div>
                {address.is_default_address_for_customer && (
                    <Badge variant="secondary" style={{ fontSize: '10px', flexShrink: 0, marginTop: '2px' }}>Default</Badge>
                )}
            </div>
            {address.id && (
                <button type="button" onClick={startEdit} title="Edit address"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#94a3b8', borderRadius: '4px', flexShrink: 0, marginTop: '2px', transition: 'color 0.15s' }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#4f46e5')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}>
                    <Pencil style={{ width: '14px', height: '14px' }} />
                </button>
            )}
        </div>
    );
}

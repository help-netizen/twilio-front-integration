import { ChevronRight, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../ui/badge';
import { toast } from 'sonner';
import type { Contact, ContactAddress } from '../../types/contact';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import { AddressAutocomplete } from '../AddressAutocomplete';
import * as contactsApi from '../../services/contactsApi';
import { Check, X } from 'lucide-react';

// ─── Shared tile styles ──────────────────────────────────────────────────────

const sectionCard: React.CSSProperties = {
    padding: '16px 16px 18px',
    borderRadius: '20px',
    border: '1px solid rgba(117, 106, 89, 0.14)',
    background: 'rgba(255, 255, 255, 0.5)',
};

const eyebrow: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    color: 'var(--blanc-ink-3)',
    marginBottom: '8px',
};

const infoRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 0',
    borderBottom: '1px dashed rgba(117, 106, 89, 0.16)',
};

const infoLabel: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--blanc-ink-3)',
    flexShrink: 0,
    width: '72px',
};

// ─── Component ───────────────────────────────────────────────────────────────

interface ContactInfoSectionsProps {
    contact: Contact;
    onAddressesChanged?: () => void;
}

export function ContactInfoSections({ contact, onAddressesChanged }: ContactInfoSectionsProps) {
    const phone = contact.phone_e164;
    const secondaryPhone = contact.secondary_phone;
    const email = contact.email;
    const name = contact.full_name;

    const hasContact = phone || secondaryPhone || email;
    const hasAddresses = contact.addresses && contact.addresses.length > 0;

    return (
        <div className="px-4 py-4 space-y-3">

            {/* ── CONTACT ── */}
            {hasContact && (
                <div style={sectionCard}>
                    <p style={eyebrow}>Contact</p>
                    {phone && (
                        <div style={infoRow}>
                            <span style={infoLabel}>Phone</span>
                            <div className="flex items-center gap-2">
                                <a href={`tel:${phone}`} className="text-[13px] font-semibold hover:underline" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {formatPhone(phone)}
                                </a>
                                <ClickToCallButton phone={phone} contactName={name || undefined} />
                                <OpenTimelineButton phone={phone} contactId={contact.id} />
                            </div>
                        </div>
                    )}
                    {secondaryPhone && (
                        <div style={infoRow}>
                            <span style={infoLabel}>{contact.secondary_phone_name || 'Phone 2'}</span>
                            <div className="flex items-center gap-2">
                                <a href={`tel:${secondaryPhone}`} className="text-[13px] font-semibold hover:underline" style={{ color: 'var(--blanc-ink-1)' }}>
                                    {formatPhone(secondaryPhone)}
                                </a>
                                <ClickToCallButton phone={secondaryPhone} contactName={name || undefined} />
                                <OpenTimelineButton phone={secondaryPhone} contactId={contact.id} />
                            </div>
                        </div>
                    )}
                    {email && (
                        <div style={{ ...infoRow, borderBottom: (!secondaryPhone && !phone) ? 'none' : infoRow.borderBottom, ...((!phone && !secondaryPhone) ? {} : {}), borderBottom: 'none', paddingBottom: 0 }}>
                            <span style={infoLabel}>Email</span>
                            <a href={`mailto:${email}`} className="text-[13px] font-semibold hover:underline" style={{ color: 'var(--blanc-ink-1)', wordBreak: 'break-all' as const }}>
                                {email}
                            </a>
                        </div>
                    )}
                </div>
            )}

            {/* ── ADDRESSES ── */}
            {hasAddresses && contact.addresses.map((addr, i) => (
                <AddressTile key={addr.id || i} address={addr} index={i} contactId={contact.id} onSaved={onAddressesChanged} />
            ))}
        </div>
    );
}

// ─── Address Tile ────────────────────────────────────────────────────────────

function AddressTile({ address, index, contactId, onSaved }: { address: ContactAddress; index: number; contactId: number; onSaved?: () => void }) {
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editedAddr, setEditedAddr] = useState({ street: '', apt: '', city: '', state: '', zip: '', lat: null as number | null, lng: null as number | null });

    const startEdit = () => {
        setEditedAddr({ street: address.line1 || '', apt: address.line2 || '', city: address.city || '', state: address.state || '', zip: address.postal_code || '', lat: address.lat ?? null, lng: address.lng ?? null });
        setEditing(true);
    };

    const saveEdit = async () => {
        if (!address.id) return;
        setSaving(true);
        try {
            await contactsApi.updateContactAddress(contactId, Number(address.id), { street: editedAddr.street, apt: editedAddr.apt, city: editedAddr.city, state: editedAddr.state, zip: editedAddr.zip, lat: editedAddr.lat, lng: editedAddr.lng });
            toast.success('Address updated');
            setEditing(false);
            onSaved?.();
        } catch { toast.error('Failed to update address'); }
        finally { setSaving(false); }
    };

    if (editing) {
        return (
            <div style={{ ...sectionCard, borderColor: 'var(--blanc-info)', borderWidth: 2 }}>
                <div className="flex items-center justify-between mb-3">
                    <p style={{ ...eyebrow, marginBottom: 0 }}>Edit Address</p>
                    <div className="flex gap-1.5">
                        <button onClick={saveEdit} disabled={saving} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white rounded-lg disabled:opacity-50" style={{ background: 'var(--blanc-info)' }}>
                            <Check className="size-3" />{saving ? 'Saving' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(false)} disabled={saving} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg disabled:opacity-50" style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-3)' }}>
                            <X className="size-3" />Cancel
                        </button>
                    </div>
                </div>
                <AddressAutocomplete idPrefix={`addr-${index}`} defaultUseDetails={true} value={editedAddr} onChange={setEditedAddr} />
            </div>
        );
    }

    const line1 = address.line1 || '';
    const unit = address.line2 ? `, ${address.line2}` : '';
    const cityLine = [address.city, address.state ? `${address.state} ${address.postal_code || ''}`.trim() : address.postal_code].filter(Boolean).join(', ');

    return (
        <div style={sectionCard}>
            <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                    <p style={{ ...eyebrow, marginBottom: 0 }}>Address</p>
                    {address.is_default_address_for_customer && <Badge variant="secondary" className="text-[10px]">Default</Badge>}
                </div>
                {address.id && (
                    <button onClick={startEdit} className="p-1 transition-opacity hover:opacity-70" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Pencil className="size-3" />
                    </button>
                )}
            </div>
            {(line1 + unit) && (
                <div className="text-[15px] leading-snug font-semibold" style={{ fontFamily: 'var(--blanc-font-heading)', letterSpacing: '-0.02em', color: 'var(--blanc-ink-1)' }}>
                    {line1 + unit}
                </div>
            )}
            {cityLine && <div className="text-[13px] mt-1" style={{ color: 'var(--blanc-ink-2)' }}>{cityLine}</div>}
        </div>
    );
}

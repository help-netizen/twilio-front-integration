import { User } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import type { Contact } from '../../types/contact';
import { LoadMoreFooter, type LoadMoreFooterProps } from '../lists/LoadMoreFooter';

interface ContactsListProps {
    contacts: Contact[];
    loading: boolean;
    selectedContactId?: number;
    onSelectContact: (contact: Contact) => void;
    footerProps: LoadMoreFooterProps;
}

function formatPhone(phone: string | null): string {
    if (!phone) return '';
    // Simple US format
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
}

export function ContactsList({
    contacts,
    loading,
    selectedContactId,
    onSelectContact,
    footerProps,
}: ContactsListProps) {
    return (
        /* Invisible layout container (LAYOUT-CANON rule 7): fills the page column,
           with the shared footer at the end of the existing scroll content. */
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '8px' }}>
            {/* List — the single scroll container; parent gap spaces the tiles (rule 2) */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full shrink-0 rounded-xl" />
                    ))
                ) : contacts.length === 0 && footerProps.state === 'error+retry' ? (
                    <LoadMoreFooter {...footerProps} />
                ) : contacts.length === 0 ? (
                    <div style={{
                        padding: '48px 16px',
                        textAlign: 'center',
                        color: '#94a3b8',
                        fontSize: '14px',
                    }}>
                        <User style={{ width: '40px', height: '40px', margin: '0 auto 12px', opacity: 0.4 }} />
                        <div>No contacts found</div>
                    </div>
                ) : (
                    <>
                    {contacts.map((contact) => (
                        /* Contact tile — the only surface above the canvas; the tile
                           itself is the flex row (no inner wrapper). Selected = warm
                           active bg (as Pulse) + line-strong inset ring. */
                        <div
                            key={contact.id}
                            onClick={() => onSelectContact(contact)}
                            className="blanc-tile"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '12px',
                                padding: '10px 12px',
                                cursor: 'pointer',
                                flexShrink: 0,
                                ...(selectedContactId === contact.id ? {
                                    background: 'rgba(127, 66, 225, 0.07)',
                                    boxShadow: 'inset 0 0 0 1px var(--blanc-line-strong)',
                                } : {}),
                            }}
                        >
                            {/* Avatar */}
                            <div style={{
                                width: '36px',
                                height: '36px',
                                borderRadius: '50%',
                                backgroundColor: '#e0e7ff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                            }}>
                                <User style={{ width: '18px', height: '18px', color: '#4f46e5' }} />
                            </div>
                            {/* Info */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{
                                    fontWeight: 500,
                                    fontSize: '14px',
                                    color: '#111827',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}>
                                    {contact.full_name || 'Unknown'}
                                </div>
                                <div style={{
                                    fontSize: '12px',
                                    color: '#6b7280',
                                    marginTop: '2px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}>
                                    {contact.phone_e164
                                        ? formatPhone(contact.phone_e164)
                                        : contact.email || '—'}
                                </div>
                            </div>
                        </div>
                    ))}
                    <LoadMoreFooter {...footerProps} />
                    </>
                )}
            </div>
        </div>
    );
}

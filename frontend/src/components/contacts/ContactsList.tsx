import { ChevronLeft, ChevronRight, User } from 'lucide-react';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import type { Contact } from '../../types/contact';

interface ContactsListProps {
    contacts: Contact[];
    loading: boolean;
    selectedContactId?: number;
    onSelectContact: (contact: Contact) => void;
    offset: number;
    hasMore: boolean;
    onNextPage: () => void;
    onPrevPage: () => void;
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
    offset,
    hasMore,
    onNextPage,
    onPrevPage,
}: ContactsListProps) {
    return (
        /* Invisible layout container (LAYOUT-CANON rule 7): fills the page column,
           no surface of its own. Rhythm to the pagination footer via gap. */
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: '8px' }}>
            {/* List — the single scroll container; parent gap spaces the tiles (rule 2) */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {loading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full shrink-0 rounded-xl" />
                    ))
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
                    contacts.map((contact) => (
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
                                    background: 'rgba(255, 247, 231, 0.7)',
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
                    ))
                )}
            </div>

            {/* Pagination — sits directly on the canvas, no card/border chrome */}
            {(offset > 0 || hasMore) && (
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexShrink: 0,
                }}>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={offset === 0}
                        onClick={onPrevPage}
                    >
                        <ChevronLeft className="size-4 mr-1" /> Prev
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasMore}
                        onClick={onNextPage}
                    >
                        Next <ChevronRight className="size-4 ml-1" />
                    </Button>
                </div>
            )}
        </div>
    );
}

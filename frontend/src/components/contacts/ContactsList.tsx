import { Search, ChevronLeft, ChevronRight, User } from 'lucide-react';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import type { Contact } from '../../types/contact';

interface ContactsListProps {
    contacts: Contact[];
    loading: boolean;
    search: string;
    onSearchChange: (value: string) => void;
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
    search,
    onSearchChange,
    selectedContactId,
    onSelectContact,
    offset,
    hasMore,
    onNextPage,
    onPrevPage,
}: ContactsListProps) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header */}
            <div style={{ padding: '16px 16px 0', borderBottom: '1px solid #e5e7eb' }}>
                <h2 style={{ margin: '0 0 12px', fontSize: '18px', fontWeight: 600, color: '#111827' }}>
                    Contacts
                </h2>
                {/* Search */}
                <div style={{ position: 'relative', marginBottom: '12px' }}>
                    <Search
                        style={{
                            position: 'absolute',
                            left: '10px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: '16px',
                            height: '16px',
                            color: '#94a3b8',
                        }}
                    />
                    <input
                        type="text"
                        placeholder="Search by name, phone, email..."
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '8px 12px 8px 34px',
                            border: '1px solid #d1d5db',
                            borderRadius: '8px',
                            fontSize: '14px',
                            outline: 'none',
                            boxSizing: 'border-box',
                        }}
                    />
                </div>
            </div>

            {/* List */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                {loading ? (
                    <div style={{ padding: '16px' }}>
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} style={{ marginBottom: '12px' }}>
                                <Skeleton className="h-14 w-full rounded-lg" />
                            </div>
                        ))}
                    </div>
                ) : contacts.length === 0 ? (
                    <div style={{
                        padding: '48px 16px',
                        textAlign: 'center',
                        color: '#94a3b8',
                        fontSize: '14px',
                    }}>
                        <User style={{ width: '40px', height: '40px', margin: '0 auto 12px', opacity: 0.4 }} />
                        <div>{search ? 'No contacts match your search' : 'No contacts found'}</div>
                    </div>
                ) : (
                    contacts.map((contact) => (
                        <div
                            key={contact.id}
                            onClick={() => onSelectContact(contact)}
                            style={{
                                padding: '12px 16px',
                                cursor: 'pointer',
                                borderBottom: '1px solid #f1f5f9',
                                backgroundColor: selectedContactId === contact.id ? '#eff6ff' : 'transparent',
                                transition: 'background-color 0.15s',
                            }}
                            onMouseEnter={(e) => {
                                if (selectedContactId !== contact.id) {
                                    e.currentTarget.style.backgroundColor = '#f8fafc';
                                }
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor =
                                    selectedContactId === contact.id ? '#eff6ff' : 'transparent';
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
                        </div>
                    ))
                )}
            </div>

            {/* Pagination */}
            {(offset > 0 || hasMore) && (
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 16px',
                    borderTop: '1px solid #e5e7eb',
                    fontSize: '13px',
                    color: '#6b7280',
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

import { useState, useEffect, useCallback } from 'react';
import { ContactsList } from '../components/contacts/ContactsList';
import { ContactDetailPanel } from '../components/contacts/ContactDetailPanel';
import * as contactsApi from '../services/contactsApi';
import type { Contact, ContactLead } from '../types/contact';

export function ContactsPage() {
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const LIMIT = 50;

    const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
    const [selectedLeads, setSelectedLeads] = useState<ContactLead[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);

    // Load contacts
    const loadContacts = useCallback(async (newSearch?: string, newOffset?: number) => {
        setLoading(true);
        try {
            const s = newSearch !== undefined ? newSearch : search;
            const o = newOffset !== undefined ? newOffset : offset;
            const res = await contactsApi.listContacts({ search: s, offset: o, limit: LIMIT });
            setContacts(res.data.results);
            setHasMore(res.data.pagination.has_more);
        } catch (err) {
            console.error('[ContactsPage] Failed to load contacts:', err);
        } finally {
            setLoading(false);
        }
    }, [search, offset]);

    useEffect(() => { loadContacts(); }, [loadContacts]);

    // Handle search
    const handleSearch = (value: string) => {
        setSearch(value);
        setOffset(0);
        loadContacts(value, 0);
    };

    // Handle pagination
    const handleNextPage = () => {
        const newOffset = offset + LIMIT;
        setOffset(newOffset);
        loadContacts(undefined, newOffset);
    };

    const handlePrevPage = () => {
        const newOffset = Math.max(0, offset - LIMIT);
        setOffset(newOffset);
        loadContacts(undefined, newOffset);
    };

    // Handle contact selection
    const handleSelectContact = async (contact: Contact) => {
        setSelectedContact(contact);
        setDetailLoading(true);
        try {
            const res = await contactsApi.getContact(contact.id);
            setSelectedContact(res.data.contact);
            setSelectedLeads(res.data.leads);
        } catch (err) {
            console.error('[ContactsPage] Failed to load contact detail:', err);
            setSelectedLeads([]);
        } finally {
            setDetailLoading(false);
        }
    };

    return (
        <div style={{ display: 'flex', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>
            {/* Left: Contacts List */}
            <div style={{ width: '380px', minWidth: '380px', borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
                <ContactsList
                    contacts={contacts}
                    loading={loading}
                    search={search}
                    onSearchChange={handleSearch}
                    selectedContactId={selectedContact?.id}
                    onSelectContact={handleSelectContact}
                    offset={offset}
                    hasMore={hasMore}
                    onNextPage={handleNextPage}
                    onPrevPage={handlePrevPage}
                />
            </div>

            {/* Right: Detail Panel */}
            <div style={{ flex: 1, overflow: 'auto' }}>
                {selectedContact ? (
                    <ContactDetailPanel
                        contact={selectedContact}
                        leads={selectedLeads}
                        loading={detailLoading}
                        onAddressesChanged={() => selectedContact && handleSelectContact(selectedContact)}
                        onContactChanged={() => selectedContact && handleSelectContact(selectedContact)}
                    />
                ) : (
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%',
                        color: '#94a3b8',
                        fontSize: '15px',
                    }}>
                        Select a contact to view details
                    </div>
                )}
            </div>
        </div>
    );
}

export default ContactsPage;

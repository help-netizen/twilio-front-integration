import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ContactsList } from '../components/contacts/ContactsList';
import { ContactDetailPanel } from '../components/contacts/ContactDetailPanel';
import * as contactsApi from '../services/contactsApi';
import type { Contact, ContactLead } from '../types/contact';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';
import { useAuthz } from '../hooks/useAuthz';
import { useDebouncedSearch } from '../hooks/useDebouncedSearch';
import { useLoadMoreList } from '../hooks/useLoadMoreList';
import type { LoadMoreFooterProps } from '../components/lists/LoadMoreFooter';

const CONTACTS_PAGE_SIZE = 50;
const contactKey = (contact: Contact) => contact.id;

export function ContactsPage() {
    const navigate = useNavigate();
    const { contactId } = useParams<{ contactId?: string }>();
    const [search, setSearch] = useState('');
    const { company, user, membership } = useAuthz();
    const debouncedSearch = useDebouncedSearch(search, 300);
    const contactsList = useLoadMoreList<Contact>({
        queryKey: [
            'contacts-list',
            company?.id ?? null,
            user?.sub ?? null,
            membership?.role_key ?? null,
            debouncedSearch,
        ],
        pageSize: CONTACTS_PAGE_SIZE,
        enabled: !!company?.id,
        fetchPage: async ({ cursor, limit, signal }) => {
            const response = await contactsApi.listContacts({
                search: debouncedSearch || undefined,
                limit,
                cursor: cursor ?? undefined,
            }, signal);
            return {
                items: response.data.results,
                pagination: {
                    ...response.data.pagination,
                    mode: 'cursor' as const,
                },
                meta: null,
            };
        },
        getItemKey: contactKey,
    });
    const contacts = contactsList.items;
    const loading = contactsList.isLoadingFirst;
    const footerProps: LoadMoreFooterProps = {
        state: contactsList.state,
        loadedCount: contacts.length,
        totalCount: contactsList.total,
        singularLabel: 'contact',
        pluralLabel: 'contacts',
        errorPhase: contactsList.errorPhase,
        onLoadMore: () => { void contactsList.loadMore(); },
        onRetry: () => { void contactsList.retry(); },
    };

    const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
    const [selectedLeads, setSelectedLeads] = useState<ContactLead[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);

    // Auto-open contact from URL param — CONTACT-NUMBERING-001: /contacts/:code is the
    // durable code; a legacy numeric id still works (old links) via the fallback below.
    useEffect(() => {
        if (!contactId) return;
        // Already showing this contact (matched by code or legacy numeric id)?
        if (selectedContact && (selectedContact.public_code === contactId || String(selectedContact.id) === contactId)) return;
        (async () => {
            setDetailLoading(true);
            try {
                let id: number;
                try {
                    const byCode = await contactsApi.getContactByCode(contactId);
                    id = byCode.data.id;
                } catch {
                    id = Number(contactId); // legacy numeric-id link
                }
                if (!id || isNaN(id)) return;
                const res = await contactsApi.getContact(id);
                setSelectedContact(res.data.contact);
                setSelectedLeads(res.data.leads);
            } catch (err) {
                console.warn('[ContactsPage] Failed to load contact from URL:', contactId, err);
            } finally {
                setDetailLoading(false);
            }
        })();
    }, [contactId]);

    // Handle contact selection
    const handleSelectContact = async (contact: Contact) => {
        // Update URL to the durable code (CONTACT-NUMBERING-001); id fallback for un-backfilled rows.
        navigate(`/contacts/${contact.public_code ?? contact.id}`, { replace: true });
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
        <div className="blanc-page-wrapper">
            <div className="blanc-unified-header">
                <h1 className="blanc-header-title">Contacts</h1>
                <div className="blanc-search-wrapper">
                    <input
                        type="text"
                        placeholder="type to find anything..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="blanc-search-input"
                    />
                </div>
            </div>
            {/* List — no page card (LAYOUT-CANON rule 7): ContactsList's root is the
                invisible layout+scroll container; the tiles carry the surface. */}
            <ContactsList
                contacts={contacts}
                loading={loading}
                selectedContactId={selectedContact?.id}
                onSelectContact={handleSelectContact}
                footerProps={footerProps}
            />
            <FloatingDetailPanel open={!!selectedContact} onClose={() => { setSelectedContact(null); navigate('/contacts', { replace: true }); }} wide>
                {selectedContact && (
                    <ContactDetailPanel
                        contact={selectedContact}
                        leads={selectedLeads}
                        loading={detailLoading}
                        onAddressesChanged={() => selectedContact && handleSelectContact(selectedContact)}
                        onContactChanged={() => {
                            if (!selectedContact) return;
                            void handleSelectContact(selectedContact).then(() => contactsList.reset());
                        }}
                    />
                )}
            </FloatingDetailPanel>
        </div>
    );
}

export default ContactsPage;

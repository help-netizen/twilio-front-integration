/**
 * ContactSearchDropdown — Debounced contact search for the SoftPhone dial input.
 *
 * Each contact phone is displayed as a separate selectable row.
 */

import React, { useState, useEffect, useRef } from 'react';
import { listContacts } from '../../services/contactsApi';
import { formatPhoneDisplay } from '../../utils/phoneUtils';

interface ContactPhoneRow {
    contactId: number;
    displayName: string;
    phone: string;
    e164: string;
    label: string;
}

interface ContactSearchDropdownProps {
    query: string;
    onSelect: (e164: string, displayName: string, displayPhone: string) => void;
    visible: boolean;
}

export const ContactSearchDropdown: React.FC<ContactSearchDropdownProps> = ({
    query,
    onSelect,
    visible,
}) => {
    const [results, setResults] = useState<ContactPhoneRow[]>([]);
    const [loading, setLoading] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!visible || !query || query.trim().length < 2) {
            setResults([]);
            return;
        }

        if (debounceRef.current) clearTimeout(debounceRef.current);

        debounceRef.current = setTimeout(async () => {
            setLoading(true);
            try {
                const response = await listContacts({ search: query.trim(), limit: 3 });
                const contacts = response.data?.results || [];

                // Flatten: each phone → separate row
                const rows: ContactPhoneRow[] = [];
                for (const contact of contacts) {
                    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';
                    const primaryPhone = contact.phone_e164;
                    const secondaryPhone = contact.secondary_phone;

                    if (primaryPhone) {
                        rows.push({
                            contactId: contact.id,
                            displayName: name,
                            phone: formatPhoneDisplay(primaryPhone),
                            e164: primaryPhone,
                            label: 'Primary',
                        });
                    }
                    if (secondaryPhone) {
                        rows.push({
                            contactId: contact.id,
                            displayName: name,
                            phone: formatPhoneDisplay(secondaryPhone),
                            e164: secondaryPhone,
                            label: contact.secondary_phone_name || 'Secondary',
                        });
                    }
                }

                setResults(rows.slice(0, 3));
            } catch (err) {
                console.error('[ContactSearch] Error:', err);
                setResults([]);
            } finally {
                setLoading(false);
            }
        }, 500);

        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [query, visible]);

    if (!visible || results.length === 0) {
        if (loading && visible) {
            return (
                <div className="softphone-search-dropdown">
                    <div className="softphone-search-loading">Searching...</div>
                </div>
            );
        }
        return null;
    }

    return (
        <div className="softphone-search-dropdown">
            {results.map((row, idx) => (
                <button
                    key={`${row.contactId}-${row.e164}-${idx}`}
                    className="softphone-search-row"
                    onClick={() => onSelect(row.e164, row.displayName, row.phone)}
                >
                    <div className="softphone-search-row-name">{row.displayName}</div>
                    <div className="softphone-search-row-phone">
                        <span>{row.phone}</span>
                        <span className="softphone-search-row-label">{row.label}</span>
                    </div>
                </button>
            ))}
        </div>
    );
};

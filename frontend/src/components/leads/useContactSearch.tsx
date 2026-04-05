import { useState, useEffect, useCallback, useRef } from 'react';
import { toE164 } from '../ui/PhoneInput';
import * as contactsApi from '../../services/contactsApi';
import type { DedupeCandidate } from '../../types/contact';
import type { SavedAddress } from '../../services/contactsApi';
import type { CreateLeadInput } from '../../types/lead';
import { User, Phone, Mail, Building2, MapPin, Check, AlertTriangle, X } from 'lucide-react';

// Snapshot for change detection
export interface ContactSnapshot {
    FirstName: string; LastName: string; Phone: string; Email: string;
    SecondPhone?: string; SecondPhoneName?: string;
    Company: string; Address: string; Unit?: string; City: string; State: string; PostalCode: string;
}

export function snapshotFromForm(f: CreateLeadInput): ContactSnapshot {
    return {
        FirstName: f.FirstName || '', LastName: f.LastName || '', Phone: f.Phone || '',
        Email: f.Email || '', SecondPhone: f.SecondPhone || '', SecondPhoneName: f.SecondPhoneName || '',
        Company: f.Company || '', Address: f.Address || '', Unit: f.Unit || '',
        City: f.City || '', State: f.State || '', PostalCode: f.PostalCode || '',
    };
}

export function hasFieldChanges(current: ContactSnapshot, original: ContactSnapshot): boolean {
    return current.FirstName !== original.FirstName || current.LastName !== original.LastName ||
        current.Phone !== original.Phone || current.Email !== original.Email ||
        (current.SecondPhone || '') !== (original.SecondPhone || '') ||
        (current.SecondPhoneName || '') !== (original.SecondPhoneName || '') ||
        current.Company !== original.Company || current.Address !== original.Address ||
        (current.Unit || '') !== (original.Unit || '') ||
        current.City !== original.City || current.State !== original.State ||
        current.PostalCode !== original.PostalCode;
}

// Debounce hook
function useDebounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fnRef = useRef(fn);
    fnRef.current = fn;
    return useCallback((...args: unknown[]) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fnRef.current(...args), delay);
    }, [delay]) as unknown as T;
}

interface UseContactSearchOptions {
    formData: CreateLeadInput;
    selectedContactId: number | null;
    setFormData: (fn: (prev: CreateLeadInput) => CreateLeadInput) => void;
    setShowSecondary: (v: boolean) => void;
    setContactSnapshot: (v: ContactSnapshot | null) => void;
}

export function useContactSearch(opts: UseContactSearchOptions) {
    const { formData, selectedContactId, setFormData, setShowSecondary, setContactSnapshot } = opts;
    const [candidates, setCandidates] = useState<DedupeCandidate[]>([]);
    const [selectedName, setSelectedName] = useState('');
    const [_searching, setSearching] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const [activeField, setActiveField] = useState<'name' | 'phone' | 'email' | null>(null);
    const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
    const [_selectedAddrId, setSelectedAddrId] = useState<number | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Fetch addresses when contact selected
    useEffect(() => {
        if (!selectedContactId) { setSavedAddresses([]); setSelectedAddrId(null); return; }
        contactsApi.getContactAddresses(selectedContactId).then(res => setSavedAddresses(res.data.addresses)).catch(() => setSavedAddresses([]));
    }, [selectedContactId]);

    const runSearch = useCallback(async () => {
        if (selectedContactId) return;
        const fn = formData.FirstName.trim(), ln = formData.LastName.trim();
        const phone = formData.Phone ? toE164(formData.Phone) : '';
        const email = formData.Email?.trim() || '';
        const hasName = fn.length >= 2 || ln.length >= 2;
        const hasPhone = phone.replace(/\D/g, '').length >= 4;
        const hasEmail = email.length >= 3 || email.includes('@');
        if (!hasName && !hasPhone && !hasEmail) { setCandidates([]); setShowDropdown(false); return; }
        setSearching(true);
        try {
            const result = await contactsApi.searchCandidates({ first_name: fn || undefined, last_name: ln || undefined, phone: phone || undefined, email: email || undefined });
            setCandidates(result.data.candidates);
            setShowDropdown(result.data.candidates.length > 0);
        } catch { /* silent */ } finally { setSearching(false); }
    }, [formData.FirstName, formData.LastName, formData.Phone, formData.Email, selectedContactId]);

    const debouncedSearch = useDebounce(runSearch, 350);

    const handleFieldChange = (field: string, value: string) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        if (field === 'FirstName' || field === 'LastName') setActiveField('name');
        else if (field === 'Phone') setActiveField('phone');
        else if (field === 'Email') setActiveField('email');
        if (!selectedContactId) debouncedSearch();
    };

    const selectCandidate = async (c: DedupeCandidate) => {
        setShowDropdown(false);
        setCandidates([]);
        setSelectedName(c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim());

        const newData: CreateLeadInput = { ...formData, FirstName: c.first_name || '', LastName: c.last_name || '', Phone: c.phone_e164 || formData.Phone, Email: c.email || formData.Email || '', Company: c.company_name || formData.Company || '' };
        if (c.secondary_phone) { newData.SecondPhone = c.secondary_phone; newData.SecondPhoneName = c.secondary_phone_name || ''; setShowSecondary(true); }
        try {
            const addrRes = await contactsApi.getContactAddresses(c.id);
            const addresses = addrRes.data.addresses;
            if (addresses.length > 0) {
                const def = addresses.find((a: SavedAddress) => a.is_primary) || addresses[0];
                newData.Address = def.street_line1 || ''; newData.Unit = def.street_line2 || '';
                newData.City = def.city || ''; newData.State = def.state || ''; newData.PostalCode = def.postal_code || '';
            }
        } catch { if (c.city) newData.City = c.city; if (c.state) newData.State = c.state; }
        setFormData(() => newData);
        setContactSnapshot(snapshotFromForm(newData));
        return c.id;
    };

    const softWarning = !selectedContactId && candidates.length > 0 && !showDropdown && candidates.some(c => c.phone_match || c.email_match);

    const renderDropdown = (fieldGroup: 'name' | 'phone' | 'email') => {
        if (!showDropdown || candidates.length === 0 || activeField !== fieldGroup) return null;
        return (
            <div className="cld-candidates">
                <div className="cld-candidates__header">{candidates.length} existing contact{candidates.length !== 1 ? 's' : ''} found</div>
                {candidates.map(c => (
                    <div key={c.id} onClick={() => selectCandidate(c)} className="cld-candidates__item">
                        <div className="cld-candidates__avatar"><User /></div>
                        <div className="cld-candidates__info">
                            <div className="cld-candidates__name">
                                <span>{c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()}</span>
                                {c.phone_match && <span className="cld-candidates__match cld-candidates__match--phone">Phone</span>}
                                {c.email_match && <span className="cld-candidates__match cld-candidates__match--email">Email</span>}
                                {c.name_match && !c.phone_match && !c.email_match && <span className="cld-candidates__match cld-candidates__match--name">Name</span>}
                            </div>
                            <div className="cld-candidates__meta">
                                {c.phone_e164 && <span className="cld-candidates__meta-item"><Phone />{c.phone_e164}</span>}
                                {c.email && <span className="cld-candidates__meta-item"><Mail />{c.email}</span>}
                                {c.company_name && <span className="cld-candidates__meta-item"><Building2 />{c.company_name}</span>}
                                {(c.city || c.state) && <span className="cld-candidates__meta-item"><MapPin />{[c.city, c.state].filter(Boolean).join(', ')}</span>}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    const renderSelectedBadge = (contactId: number | null, onRemove: () => void) => {
        if (!contactId) return null;
        return (
            <div className="cld-contact-badge">
                <Check style={{ width: 16, height: 16, color: 'var(--blanc-success)', flexShrink: 0 }} />
                <span className="cld-contact-badge__text">{selectedName}</span>
                <button type="button" onClick={onRemove} className="cld-contact-badge__remove"><X style={{ width: 12, height: 12 }} /> Remove</button>
            </div>
        );
    };

    const renderSoftWarning = () => {
        if (!softWarning) return null;
        return (
            <div className="cld-warning">
                <AlertTriangle style={{ width: 16, height: 16, color: 'var(--blanc-warning)', flexShrink: 0 }} />
                <span className="cld-warning__text">A contact with this phone/email already exists. <button type="button" onClick={() => { setActiveField('phone'); setShowDropdown(true); }} className="cld-warning__link">Select to avoid duplicates</button></span>
            </div>
        );
    };

    return {
        candidates, setCandidates, selectedName, setSelectedName, showDropdown, setShowDropdown,
        activeField, setActiveField, dropdownRef, savedAddresses, setSavedAddresses,
        setSelectedAddrId, handleFieldChange, selectCandidate, renderDropdown,
        renderSelectedBadge, renderSoftWarning,
    };
}

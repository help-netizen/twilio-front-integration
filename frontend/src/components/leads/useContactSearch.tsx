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
            <div className="absolute left-0 right-0 z-50 bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto" style={{ top: '100%', marginTop: '4px' }}>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/30">{candidates.length} existing contact{candidates.length !== 1 ? 's' : ''} found</div>
                {candidates.map(c => (
                    <div key={c.id} onClick={() => selectCandidate(c)} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors border-b last:border-b-0">
                        <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0"><User className="size-4 text-primary" /></div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium truncate">{c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()}</span>
                                {c.phone_match && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-700">Phone match</span>}
                                {c.email_match && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Email match</span>}
                                {c.name_match && !c.phone_match && !c.email_match && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">Name match</span>}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
                                {c.phone_e164 && <span className="inline-flex items-center gap-1"><Phone className="size-3" />{c.phone_e164}</span>}
                                {c.email && <span className="inline-flex items-center gap-1"><Mail className="size-3" />{c.email}</span>}
                                {c.company_name && <span className="inline-flex items-center gap-1"><Building2 className="size-3" />{c.company_name}</span>}
                                {(c.city || c.state) && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{[c.city, c.state].filter(Boolean).join(', ')}</span>}
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
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border border-green-200">
                <Check className="size-4 text-green-600 shrink-0" />
                <span className="text-sm text-green-800 font-medium flex-1">Selected existing contact: {selectedName}</span>
                <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded transition-colors"><X className="size-3" /> Remove</button>
            </div>
        );
    };

    const renderSoftWarning = () => {
        if (!softWarning) return null;
        return (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
                <AlertTriangle className="size-4 text-amber-600 shrink-0" />
                <span className="text-xs text-amber-800">A contact with this phone/email already exists.{' '}<button type="button" onClick={() => { setActiveField('phone'); setShowDropdown(true); }} className="underline font-medium hover:text-amber-900">Select it to avoid duplicates.</button></span>
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

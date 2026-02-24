import { useState, useEffect, useCallback, useRef } from 'react';
import { authedFetch } from '../../services/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { PhoneInput, toE164 } from '../ui/PhoneInput';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';
import * as leadsApi from '../../services/leadsApi';
import * as contactsApi from '../../services/contactsApi';
import type { Lead, CreateLeadInput } from '../../types/lead';
import type { DedupeCandidate } from '../../types/contact';
import type { SavedAddress } from '../../services/contactsApi';
import { User, Check, AlertTriangle, X, Phone, Mail, Building2, MapPin } from 'lucide-react';

interface CreateLeadDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: (lead: Lead) => void;
}

interface CustomFieldDef {
    id: string;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    sort_order: number;
}

const DEFAULT_JOB_TYPES = ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];
const JOB_SOURCES = ['eLocals', 'ServiceDirect', 'Inquirly', 'Rely', 'LHG', 'NSA', 'Other'];
import { AddressAutocomplete } from '../AddressAutocomplete';

// Debounce helper
function useDebounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    return useCallback((...args: unknown[]) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fn(...args), delay);
    }, [fn, delay]) as unknown as T;
}

// Snapshot of contact fields for change detection
interface ContactSnapshot {
    FirstName: string;
    LastName: string;
    Phone: string;
    Email: string;
    SecondPhone?: string;
    SecondPhoneName?: string;
    Company: string;
    Address: string;
    Unit?: string;
    City: string;
    State: string;
    PostalCode: string;
}

function snapshotFromForm(f: CreateLeadInput): ContactSnapshot {
    return {
        FirstName: f.FirstName || '',
        LastName: f.LastName || '',
        Phone: f.Phone || '',
        Email: f.Email || '',
        SecondPhone: f.SecondPhone || '',
        SecondPhoneName: f.SecondPhoneName || '',
        Company: f.Company || '',
        Address: f.Address || '',
        Unit: f.Unit || '',
        City: f.City || '',
        State: f.State || '',
        PostalCode: f.PostalCode || '',
    };
}

function hasFieldChanges(current: ContactSnapshot, original: ContactSnapshot): boolean {
    return (
        current.FirstName !== original.FirstName ||
        current.LastName !== original.LastName ||
        current.Phone !== original.Phone ||
        current.Email !== original.Email ||
        (current.SecondPhone || '') !== (original.SecondPhone || '') ||
        (current.SecondPhoneName || '') !== (original.SecondPhoneName || '') ||
        current.Company !== original.Company ||
        current.Address !== original.Address ||
        (current.Unit || '') !== (original.Unit || '') ||
        current.City !== original.City ||
        current.State !== original.State ||
        current.PostalCode !== original.PostalCode
    );
}

export function CreateLeadDialog({ open, onOpenChange, onSuccess }: CreateLeadDialogProps) {
    const [loading, setLoading] = useState(false);
    const [showSecondary, setShowSecondary] = useState(false);
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
    const [jobTypes, setJobTypes] = useState<string[]>(DEFAULT_JOB_TYPES);
    const [formData, setFormData] = useState<CreateLeadInput>({
        FirstName: '',
        LastName: '',
        Phone: '',
        Email: '',
        Company: '',
        Address: '',
        City: '',
        State: 'MA',
        PostalCode: '',
        JobType: '',
        JobSource: '',
        Description: '',
        Status: 'Submitted',
        Metadata: {},
    });

    // Contact lookup state
    const [candidates, setCandidates] = useState<DedupeCandidate[]>([]);
    const [selectedContactId, setSelectedContactId] = useState<number | null>(null);
    const [selectedContactName, setSelectedContactName] = useState<string>('');
    const [contactSnapshot, setContactSnapshot] = useState<ContactSnapshot | null>(null);
    const [_searchingContacts, setSearchingContacts] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const [activeSearchField, setActiveSearchField] = useState<'name' | 'phone' | 'email' | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Confirmation modal state
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [pendingSubmitData, setPendingSubmitData] = useState<CreateLeadInput | null>(null);

    // Address state
    const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
    const [_selectedContactAddressId, setSelectedContactAddressId] = useState<number | null>(null);

    // Fetch custom fields when dialog opens
    useEffect(() => {
        if (!open) return;
        authedFetch('/api/settings/lead-form')
            .then((r) => r.json())
            .then((data) => {
                if (data.success) {
                    const userFields = data.customFields.filter(
                        (f: CustomFieldDef) => !f.is_system
                    );
                    setCustomFields(userFields);
                    if (data.jobTypes && data.jobTypes.length > 0) {
                        setJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name));
                    }
                }
            })
            .catch(() => { });
    }, [open]);

    // Reset state when dialog closes
    useEffect(() => {
        if (!open) {
            setCandidates([]);
            setSelectedContactId(null);
            setSelectedContactName('');
            setContactSnapshot(null);
            setSavedAddresses([]);
            setSelectedContactAddressId(null);
            setShowDropdown(false);
            setShowConfirmModal(false);
            setPendingSubmitData(null);
        }
    }, [open]);

    // Fetch saved addresses when a contact is selected
    useEffect(() => {
        if (!selectedContactId) {
            setSavedAddresses([]);
            setSelectedContactAddressId(null);
            return;
        }
        contactsApi.getContactAddresses(selectedContactId)
            .then(res => setSavedAddresses(res.data.addresses))
            .catch(() => setSavedAddresses([]));
    }, [selectedContactId]);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Contact search function
    const runContactSearch = useCallback(async () => {
        // Don't search if we already have a selected contact
        if (selectedContactId) return;

        const fn = formData.FirstName.trim();
        const ln = formData.LastName.trim();
        const phone = formData.Phone ? toE164(formData.Phone) : '';
        const email = formData.Email?.trim() || '';

        // Check minimum search criteria
        const hasName = fn.length >= 2 || ln.length >= 2;
        const hasPhone = phone.replace(/\D/g, '').length >= 4;
        const hasEmail = email.length >= 3 || email.includes('@');

        if (!hasName && !hasPhone && !hasEmail) {
            setCandidates([]);
            setShowDropdown(false);
            return;
        }

        setSearchingContacts(true);
        try {
            const result = await contactsApi.searchCandidates({
                first_name: fn || undefined,
                last_name: ln || undefined,
                phone: phone || undefined,
                email: email || undefined,
            });
            const data = result.data;
            setCandidates(data.candidates);
            setShowDropdown(data.candidates.length > 0);
        } catch {
            // Silently fail — search is non-blocking
        } finally {
            setSearchingContacts(false);
        }
    }, [formData.FirstName, formData.LastName, formData.Phone, formData.Email, selectedContactId]);

    const debouncedSearch = useDebounce(runContactSearch, 350);

    // Trigger search on field change
    const handleContactFieldChange = (field: string, value: string) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        // Track which field group is active for dropdown positioning
        if (field === 'FirstName' || field === 'LastName') setActiveSearchField('name');
        else if (field === 'Phone') setActiveSearchField('phone');
        else if (field === 'Email') setActiveSearchField('email');
        // Only trigger search if no contact is selected
        if (!selectedContactId) {
            debouncedSearch();
        }
    };

    // Render dropdown under the active field group
    const renderDropdown = (fieldGroup: 'name' | 'phone' | 'email') => {
        if (!showDropdown || candidates.length === 0 || activeSearchField !== fieldGroup) return null;
        return (
            <div className="absolute left-0 right-0 z-50 bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto"
                style={{ top: '100%', marginTop: '4px' }}
            >
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/30">
                    {candidates.length} existing contact{candidates.length !== 1 ? 's' : ''} found
                </div>
                {candidates.map((c) => (
                    <div
                        key={c.id}
                        onClick={() => handleSelectCandidate(c)}
                        className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors border-b last:border-b-0"
                    >
                        <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <User className="size-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium truncate">
                                    {c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim()}
                                </span>
                                {c.phone_match && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                                        Phone match
                                    </span>
                                )}
                                {c.email_match && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                                        Email match
                                    </span>
                                )}
                                {c.name_match && !c.phone_match && !c.email_match && (
                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                                        Name match
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 flex-wrap">
                                {c.phone_e164 && (
                                    <span className="inline-flex items-center gap-1">
                                        <Phone className="size-3" />{c.phone_e164}
                                    </span>
                                )}
                                {c.email && (
                                    <span className="inline-flex items-center gap-1">
                                        <Mail className="size-3" />{c.email}
                                    </span>
                                )}
                                {c.company_name && (
                                    <span className="inline-flex items-center gap-1">
                                        <Building2 className="size-3" />{c.company_name}
                                    </span>
                                )}
                                {(c.city || c.state) && (
                                    <span className="inline-flex items-center gap-1">
                                        <MapPin className="size-3" />{[c.city, c.state].filter(Boolean).join(', ')}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    // Select a candidate contact
    const handleSelectCandidate = async (candidate: DedupeCandidate) => {
        setSelectedContactId(candidate.id);
        setSelectedContactName(candidate.full_name || `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim());
        setShowDropdown(false);
        setCandidates([]);

        // Auto-fill form fields
        const newFormData: CreateLeadInput = {
            ...formData,
            FirstName: candidate.first_name || '',
            LastName: candidate.last_name || '',
            Phone: candidate.phone_e164 || formData.Phone,
            Email: candidate.email || formData.Email || '',
            Company: candidate.company_name || formData.Company || '',
        };

        // Fill secondary phone if available
        if (candidate.secondary_phone) {
            newFormData.SecondPhone = candidate.secondary_phone;
            setShowSecondary(true);
        }

        // Fetch and fill default address
        try {
            const addrRes = await contactsApi.getContactAddresses(candidate.id);
            const addresses = addrRes.data.addresses;
            if (addresses.length > 0) {
                const defaultAddr = addresses.find((a: SavedAddress) => a.is_primary) || addresses[0];
                newFormData.Address = defaultAddr.street_line1 || '';
                newFormData.Unit = defaultAddr.street_line2 || '';
                newFormData.City = defaultAddr.city || '';
                newFormData.State = defaultAddr.state || '';
                newFormData.PostalCode = defaultAddr.postal_code || '';
            }
        } catch {
            // Address fetch failed — use city/state from candidate if available
            if (candidate.city) newFormData.City = candidate.city;
            if (candidate.state) newFormData.State = candidate.state;
        }

        setFormData(newFormData);
        setContactSnapshot(snapshotFromForm(newFormData));
    };

    // Remove/detach selected contact
    const handleRemoveContact = () => {
        setSelectedContactId(null);
        setSelectedContactName('');
        setContactSnapshot(null);
        setSavedAddresses([]);
        setSelectedContactAddressId(null);
    };

    // Submit logic
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.FirstName || !formData.LastName || !formData.Phone) {
            toast.error('Please fill in required fields');
            return;
        }

        // If we have a selected contact, check for changes
        if (selectedContactId && contactSnapshot) {
            const currentSnapshot = snapshotFromForm(formData);
            if (hasFieldChanges(currentSnapshot, contactSnapshot)) {
                // Show confirmation modal
                setPendingSubmitData(formData);
                setShowConfirmModal(true);
                return;
            }
        }

        // No changes or no contact selected — submit directly
        await submitLead(formData, selectedContactId ? 'attach' : 'create_new');
    };

    // Do the actual submission
    const submitLead = async (data: CreateLeadInput, mode: string) => {
        setLoading(true);
        setShowConfirmModal(false);
        try {
            const submitData: Record<string, unknown> = {
                ...data,
                Phone: toE164(data.Phone),
            };

            if (selectedContactId && mode !== 'only_lead') {
                submitData.selected_contact_id = selectedContactId;
                submitData.contact_update_mode = mode === 'update_contact' ? 'update_contact' : undefined;
            }
            if (mode === 'only_lead') {
                submitData.contact_update_mode = 'only_lead';
            }

            const result = await leadsApi.createLead(submitData as CreateLeadInput);
            const detail = await leadsApi.getLeadByUUID(result.data.UUID!);
            onSuccess(detail.data.lead);

            if (result.data.contact_resolution?.status === 'matched') {
                toast.success(mode === 'update_contact'
                    ? 'Lead created & contact updated'
                    : 'Lead linked to existing contact');
            }

            // Reset form
            setFormData({
                FirstName: '',
                LastName: '',
                Phone: '',
                Email: '',
                Company: '',
                Address: '',
                City: '',
                State: 'MA',
                PostalCode: '',
                JobType: '',
                JobSource: '',
                Description: '',
                Status: 'Submitted',
                Metadata: {},
            });
            setCandidates([]);
            setSelectedContactId(null);
            setSelectedContactName('');
            setContactSnapshot(null);
        } catch (error: unknown) {
            const err = error as { response?: { status?: number }; message?: string };
            toast.error('Failed to create lead', {
                description: err.message || 'Unknown error'
            });
        } finally {
            setLoading(false);
            setPendingSubmitData(null);
        }
    };

    const updateMetadata = (apiName: string, value: string) => {
        setFormData((prev) => ({
            ...prev,
            Metadata: { ...(prev.Metadata || {}), [apiName]: value },
        }));
    };

    // Soft warning: phone/email match exists but user hasn't selected
    const softWarning = !selectedContactId && candidates.length > 0 && !showDropdown
        && candidates.some(c => c.phone_match || c.email_match);

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Create New Lead</DialogTitle>
                        <DialogDescription>Enter the lead's details below to create a new lead.</DialogDescription>
                    </DialogHeader>

                    <form onSubmit={handleSubmit} className="space-y-6">
                        {/* Contact Information */}
                        <div className="space-y-4" ref={dropdownRef}>
                            <h3 className="font-medium">Contact Information</h3>

                            {/* Name row + dropdown anchor */}
                            <div className="relative">
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <Label htmlFor="firstName" className="mb-2">
                                            First Name <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            id="firstName"
                                            value={formData.FirstName}
                                            onChange={(e) => handleContactFieldChange('FirstName', e.target.value)}
                                            required
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="lastName" className="mb-2">
                                            Last Name <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            id="lastName"
                                            value={formData.LastName}
                                            onChange={(e) => handleContactFieldChange('LastName', e.target.value)}
                                            required
                                        />
                                    </div>
                                </div>
                                {renderDropdown('name')}
                            </div>

                            {/* Phone / Email row + dropdown anchor */}
                            <div className="relative">
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <Label htmlFor="phone" className="mb-2">
                                            Phone <span className="text-destructive">*</span>
                                        </Label>
                                        <PhoneInput
                                            id="phone"
                                            value={formData.Phone}
                                            onChange={(formatted) => handleContactFieldChange('Phone', formatted)}
                                            required
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="email" className="mb-2">Email</Label>
                                        <Input
                                            id="email"
                                            type="email"
                                            value={formData.Email}
                                            onChange={(e) => handleContactFieldChange('Email', e.target.value)}
                                        />
                                    </div>
                                </div>
                                {renderDropdown('phone')}
                                {renderDropdown('email')}
                            </div>

                            {!showSecondary ? (
                                <button
                                    type="button"
                                    onClick={() => setShowSecondary(true)}
                                    className="text-xs text-primary hover:underline"
                                >
                                    + Secondary Phone
                                </button>
                            ) : (
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <Label htmlFor="secondPhone" className="mb-2">Secondary Phone</Label>
                                        <PhoneInput
                                            id="secondPhone"
                                            value={formData.SecondPhone || ''}
                                            onChange={(formatted) => setFormData({ ...formData, SecondPhone: formatted })}
                                        />
                                    </div>
                                    <div>
                                        <Label htmlFor="secondPhoneName" className="mb-2">Secondary Name</Label>
                                        <Input
                                            id="secondPhoneName"
                                            value={formData.SecondPhoneName || ''}
                                            onChange={(e) => setFormData({ ...formData, SecondPhoneName: e.target.value })}
                                            placeholder="e.g. Tenant, Wife"
                                        />
                                    </div>
                                </div>
                            )}

                            <div>
                                <Label htmlFor="company" className="mb-2">Company</Label>
                                <Input
                                    id="company"
                                    value={formData.Company}
                                    onChange={(e) => setFormData({ ...formData, Company: e.target.value })}
                                />
                            </div>

                            {/* Selected contact indicator */}
                            {selectedContactId && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-50 border border-green-200">
                                    <Check className="size-4 text-green-600 shrink-0" />
                                    <span className="text-sm text-green-800 font-medium flex-1">
                                        Selected existing contact: {selectedContactName}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={handleRemoveContact}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded transition-colors"
                                    >
                                        <X className="size-3" />
                                        Remove
                                    </button>
                                </div>
                            )}

                            {/* Soft warning */}
                            {softWarning && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
                                    <AlertTriangle className="size-4 text-amber-600 shrink-0" />
                                    <span className="text-xs text-amber-800">
                                        A contact with this phone/email already exists.{' '}
                                        <button
                                            type="button"
                                            onClick={() => { setActiveSearchField('phone'); setShowDropdown(true); }}
                                            className="underline font-medium hover:text-amber-900"
                                        >
                                            Select it to avoid duplicates.
                                        </button>
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Address */}
                        <div className="space-y-4">
                            <AddressAutocomplete
                                header={<h3 className="font-medium">Address</h3>}
                                idPrefix="create-lead"
                                defaultUseDetails={true}
                                savedAddresses={savedAddresses}
                                onSelectSaved={(id) => setSelectedContactAddressId(id)}
                                value={{
                                    street: formData.Address || '',
                                    apt: formData.Unit || '',
                                    city: formData.City || '',
                                    state: formData.State || '',
                                    zip: formData.PostalCode || '',
                                }}
                                onChange={(addr) => {
                                    setSelectedContactAddressId(null);
                                    setFormData({
                                        ...formData,
                                        Address: addr.street,
                                        Unit: addr.apt || '',
                                        City: addr.city,
                                        State: addr.state,
                                        PostalCode: addr.zip,
                                        Latitude: addr.lat ?? null,
                                        Longitude: addr.lng ?? null,
                                    });
                                }}
                            />
                        </div>

                        {/* Job Details */}
                        <div className="space-y-4">
                            <h3 className="font-medium">Job Details</h3>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <Label htmlFor="jobType" className="mb-2">Job Type</Label>
                                    <Select
                                        value={formData.JobType}
                                        onValueChange={(value) => setFormData({ ...formData, JobType: value })}
                                    >
                                        <SelectTrigger id="jobType">
                                            <SelectValue placeholder="Select job type" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {jobTypes.map((type) => (
                                                <SelectItem key={type} value={type}>
                                                    {type}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <Label htmlFor="jobSource" className="mb-2">Job Source</Label>
                                    <Select
                                        value={formData.JobSource}
                                        onValueChange={(value) => setFormData({ ...formData, JobSource: value })}
                                    >
                                        <SelectTrigger id="jobSource">
                                            <SelectValue placeholder="Select source" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {JOB_SOURCES.map((source) => (
                                                <SelectItem key={source} value={source}>
                                                    {source}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div>
                                <Label htmlFor="leadNotes" className="mb-2">Description</Label>
                                <Textarea
                                    id="leadNotes"
                                    value={formData.Description}
                                    onChange={(e) => setFormData({ ...formData, Description: e.target.value })}
                                    rows={3}
                                    placeholder="Additional notes about this lead..."
                                />
                            </div>
                        </div>

                        {/* Custom Metadata Fields */}
                        {customFields.length > 0 && (
                            <div className="space-y-4">
                                <h3 className="font-medium">Metadata</h3>
                                <div className="grid grid-cols-2 gap-4">
                                    {customFields.map((field) => (
                                        <div key={field.id} className={field.field_type === 'textarea' || field.field_type === 'richtext' ? 'col-span-2' : ''}>
                                            <Label htmlFor={`meta-${field.api_name}`} className="mb-2">
                                                {field.display_name}
                                            </Label>
                                            {field.field_type === 'textarea' || field.field_type === 'richtext' ? (
                                                <Textarea
                                                    id={`meta-${field.api_name}`}
                                                    value={formData.Metadata?.[field.api_name] || ''}
                                                    onChange={(e) => updateMetadata(field.api_name, e.target.value)}
                                                    rows={3}
                                                />
                                            ) : (
                                                <Input
                                                    id={`meta-${field.api_name}`}
                                                    type={field.field_type === 'number' ? 'number' : 'text'}
                                                    value={formData.Metadata?.[field.api_name] || ''}
                                                    onChange={(e) => updateMetadata(field.api_name, e.target.value)}
                                                />
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={loading}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={loading}>
                                {loading ? 'Creating...' : 'Create Lead'}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* Confirmation Modal: "Change client" */}
            <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Change client</DialogTitle>
                        <DialogDescription>
                            Do you want these changes to also be applied to the client?
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-2 pt-2">
                        <Button
                            onClick={() => {
                                if (pendingSubmitData) submitLead(pendingSubmitData, 'update_contact');
                            }}
                            disabled={loading}
                        >
                            {loading ? 'Saving...' : 'Update contact'}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => {
                                if (pendingSubmitData) submitLead(pendingSubmitData, 'only_lead');
                            }}
                            disabled={loading}
                        >
                            Only lead
                        </Button>
                        <Button
                            variant="ghost"
                            onClick={() => { setShowConfirmModal(false); setPendingSubmitData(null); }}
                            disabled={loading}
                        >
                            Cancel
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

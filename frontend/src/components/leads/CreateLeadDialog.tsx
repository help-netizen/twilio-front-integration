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
import { User, Check, AlertTriangle, Mail } from 'lucide-react';

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

const JOB_TYPES = ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];
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

export function CreateLeadDialog({ open, onOpenChange, onSuccess }: CreateLeadDialogProps) {
    const [loading, setLoading] = useState(false);
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
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
        JobType: 'COD Service',
        JobSource: '',
        Description: '',
        Status: 'Submitted',
        Metadata: {},
    });

    // Dedupe state
    const [candidates, setCandidates] = useState<DedupeCandidate[]>([]);
    const [matchHint, setMatchHint] = useState<string>('none');
    const [willEnrichEmail, setWillEnrichEmail] = useState(false);
    const [selectedContactId, setSelectedContactId] = useState<number | null>(null);
    const [searchingContacts, setSearchingContacts] = useState(false);

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
                }
            })
            .catch(() => { });
    }, [open]);

    // Reset dedupe state when dialog opens
    useEffect(() => {
        if (!open) {
            setCandidates([]);
            setMatchHint('none');
            setWillEnrichEmail(false);
            setSelectedContactId(null);
            setSavedAddresses([]);
            setSelectedContactAddressId(null);
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

    // Contact search function
    const runContactSearch = useCallback(async () => {
        const fn = formData.FirstName.trim();
        const ln = formData.LastName.trim();
        if (!fn || !ln) {
            setCandidates([]);
            setMatchHint('none');
            setWillEnrichEmail(false);
            setSelectedContactId(null);
            return;
        }

        setSearchingContacts(true);
        try {
            const result = await contactsApi.searchCandidates({
                first_name: fn,
                last_name: ln,
                phone: formData.Phone ? toE164(formData.Phone) : undefined,
                email: formData.Email || undefined,
            });
            const data = result.data;
            setCandidates(data.candidates);
            setMatchHint(data.match_hint);
            setWillEnrichEmail(data.will_enrich_email);

            // Auto-select if exactly one phone or email match
            if (data.match_hint === 'phone' || data.match_hint === 'email') {
                const match = data.candidates.find(c => c.phone_match || c.email_match);
                setSelectedContactId(match ? match.id : null);
            } else {
                setSelectedContactId(null);
            }
        } catch {
            // Silently fail — dedupe is non-blocking
        } finally {
            setSearchingContacts(false);
        }
    }, [formData.FirstName, formData.LastName, formData.Phone, formData.Email]);

    const debouncedSearch = useDebounce(runContactSearch, 400);

    // Re-search on field blur (name, phone, email)
    const handleFieldBlur = () => {
        if (formData.FirstName.trim() && formData.LastName.trim()) {
            debouncedSearch();
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.FirstName || !formData.LastName || !formData.Phone) {
            toast.error('Please fill in required fields');
            return;
        }

        // If ambiguous and no selection, block
        if (matchHint === 'phone_ambiguous' || matchHint === 'email_ambiguous' || matchHint === 'name_only') {
            if (candidates.length > 0 && selectedContactId === null) {
                toast.error('Please select an existing contact or confirm creating a new one');
                return;
            }
        }

        setLoading(true);
        try {
            const submitData = { ...formData, Phone: toE164(formData.Phone) };
            const result = await leadsApi.createLead(submitData);
            const detail = await leadsApi.getLeadByUUID(result.data.UUID!);
            onSuccess(detail.data.lead);

            // Show enrichment toast
            if (result.data.contact_resolution?.email_enriched) {
                toast.info('Email added to existing contact');
            }
            if (result.data.contact_resolution?.status === 'matched') {
                toast.success(`Lead linked to existing contact`);
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
                JobType: 'COD Service',
                JobSource: '',
                Description: '',
                Status: 'Submitted',
                Metadata: {},
            });
            setCandidates([]);
            setMatchHint('none');
            setWillEnrichEmail(false);
            setSelectedContactId(null);
        } catch (error: unknown) {
            const err = error as { response?: { status?: number }; message?: string };
            if (err.response?.status === 409) {
                toast.error('Multiple matching contacts found. Please select one above.');
            } else {
                toast.error('Failed to create lead', {
                    description: err.message || 'Unknown error'
                });
            }
        } finally {
            setLoading(false);
        }
    };

    const updateMetadata = (apiName: string, value: string) => {
        setFormData((prev) => ({
            ...prev,
            Metadata: { ...(prev.Metadata || {}), [apiName]: value },
        }));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Create New Lead</DialogTitle>
                    <DialogDescription>Enter the lead's details below to create a new lead.</DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-6">
                    {/* Contact Information */}
                    <div className="space-y-4">
                        <h3 className="font-medium">Contact Information</h3>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <Label htmlFor="firstName" className="mb-2">
                                    First Name <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="firstName"
                                    value={formData.FirstName}
                                    onChange={(e) => setFormData({ ...formData, FirstName: e.target.value })}
                                    onBlur={handleFieldBlur}
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
                                    onChange={(e) => setFormData({ ...formData, LastName: e.target.value })}
                                    onBlur={handleFieldBlur}
                                    required
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <Label htmlFor="phone" className="mb-2">
                                    Phone <span className="text-destructive">*</span>
                                </Label>
                                <PhoneInput
                                    id="phone"
                                    value={formData.Phone}
                                    onChange={(formatted) => setFormData({ ...formData, Phone: formatted })}
                                    onBlur={handleFieldBlur}
                                    required
                                />
                            </div>
                            <div>
                                <Label htmlFor="email" className="mb-2">Email</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    value={formData.Email}
                                    onChange={(e) => setFormData({ ...formData, Email: e.target.value })}
                                    onBlur={handleFieldBlur}
                                />
                            </div>
                        </div>

                        <div>
                            <Label htmlFor="company" className="mb-2">Company</Label>
                            <Input
                                id="company"
                                value={formData.Company}
                                onChange={(e) => setFormData({ ...formData, Company: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Contact Match Card */}
                    {(candidates.length > 0 || searchingContacts) && (
                        <ContactMatchSection
                            candidates={candidates}
                            matchHint={matchHint}
                            willEnrichEmail={willEnrichEmail}
                            selectedContactId={selectedContactId}
                            onSelect={setSelectedContactId}
                            searching={searchingContacts}
                        />
                    )}

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
                                setSelectedContactAddressId(null); // clear selection when typing new
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
                                        {JOB_TYPES.map((type) => (
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
    );
}

// =============================================================================
// Contact Match Section — shows candidate cards
// =============================================================================

function ContactMatchSection({
    candidates,
    matchHint,
    willEnrichEmail,
    selectedContactId,
    onSelect,
    searching,
}: {
    candidates: DedupeCandidate[];
    matchHint: string;
    willEnrichEmail: boolean;
    selectedContactId: number | null;
    onSelect: (id: number | null) => void;
    searching: boolean;
}) {
    if (searching) {
        return (
            <div style={{
                padding: '12px 16px',
                backgroundColor: '#f0f9ff',
                borderRadius: '8px',
                border: '1px solid #bae6fd',
                fontSize: '13px',
                color: '#0369a1',
            }}>
                Searching for existing contacts...
            </div>
        );
    }

    if (candidates.length === 0) return null;

    const isAutoSelected = matchHint === 'phone' || matchHint === 'email';
    const isAmbiguous = matchHint === 'phone_ambiguous' || matchHint === 'email_ambiguous' || matchHint === 'name_only';

    return (
        <div style={{
            borderRadius: '10px',
            border: isAutoSelected ? '1px solid #86efac' : '1px solid #fde68a',
            backgroundColor: isAutoSelected ? '#f0fdf4' : '#fffbeb',
            padding: '14px 16px',
        }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                marginBottom: '10px', fontSize: '13px', fontWeight: 600,
                color: isAutoSelected ? '#166534' : '#92400e',
            }}>
                {isAutoSelected ? (
                    <>
                        <Check style={{ width: '16px', height: '16px' }} />
                        Using existing contact
                    </>
                ) : (
                    <>
                        <AlertTriangle style={{ width: '16px', height: '16px' }} />
                        {isAmbiguous
                            ? `${candidates.length} matching contact(s) found — please select one or create new`
                            : 'Similar contacts found'}
                    </>
                )}
            </div>

            {/* Email enrichment notice */}
            {willEnrichEmail && (
                <div style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '8px 12px', marginBottom: '10px',
                    backgroundColor: '#eff6ff', borderRadius: '6px',
                    fontSize: '12px', color: '#1e40af',
                    border: '1px solid #bfdbfe',
                }}>
                    <Mail style={{ width: '14px', height: '14px' }} />
                    Email will be added to this client's additional emails
                </div>
            )}

            {/* Candidate cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {candidates.map((c) => {
                    const isSelected = selectedContactId === c.id;
                    return (
                        <div
                            key={c.id}
                            onClick={() => onSelect(isSelected ? null : c.id)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '10px',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border: isSelected ? '2px solid #22c55e' : '1px solid #e5e7eb',
                                backgroundColor: isSelected ? '#f0fdf4' : '#fff',
                                cursor: isAmbiguous ? 'pointer' : 'default',
                                transition: 'all 0.15s',
                            }}
                        >
                            <div style={{
                                width: '32px', height: '32px', borderRadius: '50%',
                                backgroundColor: isSelected ? '#dcfce7' : '#e0e7ff',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexShrink: 0,
                            }}>
                                {isSelected
                                    ? <Check style={{ width: '16px', height: '16px', color: '#16a34a' }} />
                                    : <User style={{ width: '16px', height: '16px', color: '#4f46e5' }} />
                                }
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: '14px', fontWeight: 500, color: '#111827' }}>
                                    {c.full_name || `${c.first_name} ${c.last_name}`}
                                    {c.phone_match && (
                                        <span style={{
                                            marginLeft: '8px', fontSize: '10px', fontWeight: 600,
                                            padding: '1px 6px', borderRadius: '4px',
                                            backgroundColor: '#dcfce7', color: '#166534',
                                        }}>PHONE MATCH</span>
                                    )}
                                    {c.email_match && (
                                        <span style={{
                                            marginLeft: '8px', fontSize: '10px', fontWeight: 600,
                                            padding: '1px 6px', borderRadius: '4px',
                                            backgroundColor: '#dbeafe', color: '#1e40af',
                                        }}>EMAIL MATCH</span>
                                    )}
                                </div>
                                <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>
                                    {c.phone_e164 || '—'}
                                    {c.email && ` · ${c.email}`}
                                    {c.additional_emails.length > 0 && ` (+${c.additional_emails.length} emails)`}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {/* "Create new" option for ambiguous cases */}
                {isAmbiguous && (
                    <div
                        onClick={() => onSelect(null)}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '10px',
                            padding: '10px 12px',
                            borderRadius: '8px',
                            border: selectedContactId === null ? '2px solid #3b82f6' : '1px dashed #d1d5db',
                            backgroundColor: selectedContactId === null ? '#eff6ff' : '#fafafa',
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                        }}
                    >
                        <div style={{
                            width: '32px', height: '32px', borderRadius: '50%',
                            backgroundColor: selectedContactId === null ? '#dbeafe' : '#f3f4f6',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0, fontSize: '16px', fontWeight: 600,
                            color: selectedContactId === null ? '#2563eb' : '#9ca3af',
                        }}>
                            +
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 500, color: '#374151' }}>
                            Create new contact
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

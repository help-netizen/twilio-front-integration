import { useState, useEffect } from 'react';
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
import type { Lead, CreateLeadInput } from '../../types/lead';

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
        LeadNotes: '',
        Status: 'Submitted',
        Metadata: {},
    });

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

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.FirstName || !formData.LastName || !formData.Phone) {
            toast.error('Please fill in required fields');
            return;
        }

        setLoading(true);
        try {
            const submitData = { ...formData, Phone: toE164(formData.Phone) };
            const result = await leadsApi.createLead(submitData);
            // Fetch the created lead to get full details
            const detail = await leadsApi.getLeadByUUID(result.data.UUID!);
            onSuccess(detail.data.lead);

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
                LeadNotes: '',
                Status: 'Submitted',
                Metadata: {},
            });
        } catch (error) {
            toast.error('Failed to create lead', {
                description: error instanceof Error ? error.message : 'Unknown error'
            });
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

                    {/* Address */}
                    <div className="space-y-4">
                        <h3 className="font-medium">Address</h3>
                        <AddressAutocomplete
                            idPrefix="create-lead"
                            value={{
                                street: formData.Address || '',
                                apt: '',
                                city: formData.City || '',
                                state: formData.State || '',
                                zip: formData.PostalCode || '',
                            }}
                            onChange={(addr) => setFormData({
                                ...formData,
                                Address: addr.street,
                                City: addr.city,
                                State: addr.state,
                                PostalCode: addr.zip,
                            })}
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
                            <Label htmlFor="leadNotes" className="mb-2">Lead Notes</Label>
                            <Textarea
                                id="leadNotes"
                                value={formData.LeadNotes}
                                onChange={(e) => setFormData({ ...formData, LeadNotes: e.target.value })}
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

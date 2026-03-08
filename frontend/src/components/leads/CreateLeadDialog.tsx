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
import { AddressAutocomplete } from '../AddressAutocomplete';
import { useContactSearch, snapshotFromForm, hasFieldChanges } from './useContactSearch';

interface CreateLeadDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: (lead: Lead) => void;
}

interface CustomFieldDef { id: string; display_name: string; api_name: string; field_type: string; is_system: boolean; sort_order: number; }

const DEFAULT_JOB_TYPES = ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];
const JOB_SOURCES = ['eLocals', 'ServiceDirect', 'Inquirly', 'Rely', 'LHG', 'NSA', 'Other'];

export function CreateLeadDialog({ open, onOpenChange, onSuccess }: CreateLeadDialogProps) {
    const [loading, setLoading] = useState(false);
    const [showSecondary, setShowSecondary] = useState(false);
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
    const [jobTypes, setJobTypes] = useState<string[]>(DEFAULT_JOB_TYPES);
    const [formData, setFormData] = useState<CreateLeadInput>({
        FirstName: '', LastName: '', Phone: '', Email: '', Company: '',
        Address: '', City: '', State: 'MA', PostalCode: '',
        JobType: '', JobSource: '', Description: '', Status: 'Submitted', Metadata: {},
    });
    const [selectedContactId, setSelectedContactId] = useState<number | null>(null);
    const [contactSnapshot, setContactSnapshot] = useState<ReturnType<typeof snapshotFromForm> | null>(null);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [pendingSubmitData, setPendingSubmitData] = useState<CreateLeadInput | null>(null);

    const cs = useContactSearch({
        formData, selectedContactId,
        setFormData: (fn) => setFormData(fn),
        setShowSecondary, setContactSnapshot,
    });

    useEffect(() => {
        if (!open) return;
        authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => {
            if (data.success) {
                setCustomFields(data.customFields.filter((f: CustomFieldDef) => !f.is_system));
                if (data.jobTypes?.length > 0) setJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name));
            }
        }).catch(() => { });
    }, [open]);

    useEffect(() => {
        if (!open) {
            cs.setCandidates([]); setSelectedContactId(null); cs.setSelectedName(''); setContactSnapshot(null);
            cs.setSavedAddresses([]); cs.setSelectedAddrId(null); cs.setShowDropdown(false);
            setShowConfirmModal(false); setPendingSubmitData(null);
        }
    }, [open]);

    const handleRemoveContact = () => { setSelectedContactId(null); cs.setSelectedName(''); setContactSnapshot(null); cs.setSavedAddresses([]); cs.setSelectedAddrId(null); };



    const submitLead = async (data: CreateLeadInput, mode: string) => {
        setLoading(true); setShowConfirmModal(false);
        try {
            const submitData: Record<string, unknown> = { ...data, Phone: toE164(data.Phone) };
            if (selectedContactId && mode !== 'only_lead') { submitData.selected_contact_id = selectedContactId; submitData.contact_update_mode = mode === 'update_contact' ? 'update_contact' : undefined; }
            if (mode === 'only_lead') submitData.contact_update_mode = 'only_lead';
            const result = await leadsApi.createLead(submitData as CreateLeadInput);
            const detail = await leadsApi.getLeadByUUID(result.data.UUID!);
            onSuccess(detail.data.lead);
            if (result.data.contact_resolution?.status === 'matched') toast.success(mode === 'update_contact' ? 'Lead created & contact updated' : 'Lead linked to existing contact');
            setFormData({ FirstName: '', LastName: '', Phone: '', Email: '', Company: '', Address: '', City: '', State: 'MA', PostalCode: '', JobType: '', JobSource: '', Description: '', Status: 'Submitted', Metadata: {} });
            cs.setCandidates([]); setSelectedContactId(null); cs.setSelectedName(''); setContactSnapshot(null);
        } catch (error: unknown) {
            const err = error as { message?: string };
            toast.error('Failed to create lead', { description: err.message || 'Unknown error' });
        } finally { setLoading(false); setPendingSubmitData(null); }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.FirstName || !formData.LastName || !formData.Phone) { toast.error('Please fill in required fields'); return; }
        if (selectedContactId && contactSnapshot) {
            const current = snapshotFromForm(formData);
            if (hasFieldChanges(current, contactSnapshot)) { setPendingSubmitData(formData); setShowConfirmModal(true); return; }
        }
        await submitLead(formData, selectedContactId ? 'attach' : 'create_new');
    };

    const updateMetadata = (apiName: string, value: string) => setFormData(prev => ({ ...prev, Metadata: { ...(prev.Metadata || {}), [apiName]: value } }));

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader><DialogTitle>Create New Lead</DialogTitle><DialogDescription>Enter the lead's details below to create a new lead.</DialogDescription></DialogHeader>
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-4" ref={cs.dropdownRef}>
                            <h3 className="font-medium">Contact Information</h3>
                            {cs.renderSelectedBadge(selectedContactId, handleRemoveContact)}
                            {cs.renderSoftWarning()}
                            <div className="relative">
                                <div className="grid grid-cols-2 gap-4">
                                    <div><Label htmlFor="firstName" className="mb-2">First Name <span className="text-destructive">*</span></Label><Input id="firstName" value={formData.FirstName} onChange={(e) => cs.handleFieldChange('FirstName', e.target.value)} required /></div>
                                    <div><Label htmlFor="lastName" className="mb-2">Last Name <span className="text-destructive">*</span></Label><Input id="lastName" value={formData.LastName} onChange={(e) => cs.handleFieldChange('LastName', e.target.value)} required /></div>
                                </div>
                                {cs.renderDropdown('name')}
                            </div>
                            <div className="relative">
                                <div className="grid grid-cols-2 gap-4">
                                    <div><Label htmlFor="phone" className="mb-2">Phone <span className="text-destructive">*</span></Label><PhoneInput id="phone" value={formData.Phone} onChange={(f) => cs.handleFieldChange('Phone', f)} required /></div>
                                    <div><Label htmlFor="email" className="mb-2">Email</Label><Input id="email" type="email" value={formData.Email} onChange={(e) => cs.handleFieldChange('Email', e.target.value)} /></div>
                                </div>
                                {cs.renderDropdown('phone')}{cs.renderDropdown('email')}
                            </div>
                            {!showSecondary ? <button type="button" onClick={() => setShowSecondary(true)} className="text-xs text-primary hover:underline">+ Secondary Phone</button> : (
                                <div className="grid grid-cols-2 gap-4">
                                    <div><Label htmlFor="secondPhone" className="mb-2">Secondary Phone</Label><PhoneInput id="secondPhone" value={formData.SecondPhone || ''} onChange={(f) => setFormData({ ...formData, SecondPhone: f })} /></div>
                                    <div><Label htmlFor="secondPhoneName" className="mb-2">Secondary Name</Label><Input id="secondPhoneName" value={formData.SecondPhoneName || ''} onChange={(e) => setFormData({ ...formData, SecondPhoneName: e.target.value })} placeholder="e.g. Tenant, Wife" /></div>
                                </div>
                            )}
                            <div><Label htmlFor="company" className="mb-2">Company</Label><Input id="company" value={formData.Company} onChange={(e) => setFormData({ ...formData, Company: e.target.value })} /></div>
                        </div>
                        <div className="space-y-4">
                            <AddressAutocomplete header={<h3 className="font-medium">Address</h3>} idPrefix="create-lead" defaultUseDetails={true} savedAddresses={cs.savedAddresses} onSelectSaved={(id) => cs.setSelectedAddrId(id)}
                                value={{ street: formData.Address || '', apt: formData.Unit || '', city: formData.City || '', state: formData.State || '', zip: formData.PostalCode || '' }}
                                onChange={(addr) => { cs.setSelectedAddrId(null); setFormData({ ...formData, Address: addr.street, Unit: addr.apt || '', City: addr.city, State: addr.state, PostalCode: addr.zip, Latitude: addr.lat ?? null, Longitude: addr.lng ?? null }); }} />
                        </div>
                        <div className="space-y-4">
                            <h3 className="font-medium">Job Details</h3>
                            <div className="grid grid-cols-2 gap-4">
                                <div><Label htmlFor="jobType" className="mb-2">Job Type</Label><Select value={formData.JobType} onValueChange={(v) => setFormData({ ...formData, JobType: v })}><SelectTrigger id="jobType"><SelectValue placeholder="Select job type" /></SelectTrigger><SelectContent>{jobTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
                                <div><Label htmlFor="jobSource" className="mb-2">Job Source</Label><Select value={formData.JobSource} onValueChange={(v) => setFormData({ ...formData, JobSource: v })}><SelectTrigger id="jobSource"><SelectValue placeholder="Select source" /></SelectTrigger><SelectContent>{JOB_SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></div>
                            </div>
                            <div><Label htmlFor="leadNotes" className="mb-2">Description</Label><Textarea id="leadNotes" value={formData.Description} onChange={(e) => setFormData({ ...formData, Description: e.target.value })} rows={3} placeholder="Additional notes about this lead..." /></div>
                        </div>
                        {customFields.length > 0 && (
                            <div className="space-y-4">
                                <h3 className="font-medium">Metadata</h3>
                                <div className="grid grid-cols-2 gap-4">
                                    {customFields.map(field => (
                                        <div key={field.id} className={field.field_type === 'textarea' || field.field_type === 'richtext' ? 'col-span-2' : ''}>
                                            <Label htmlFor={`meta-${field.api_name}`} className="mb-2">{field.display_name}</Label>
                                            {field.field_type === 'textarea' || field.field_type === 'richtext' ? <Textarea id={`meta-${field.api_name}`} value={formData.Metadata?.[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} rows={3} /> : <Input id={`meta-${field.api_name}`} type={field.field_type === 'number' ? 'number' : 'text'} value={formData.Metadata?.[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} />}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
                            <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Lead'}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
            <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
                <DialogContent className="max-w-sm">
                    <DialogHeader><DialogTitle>Change client</DialogTitle><DialogDescription>Do you want these changes to also be applied to the client?</DialogDescription></DialogHeader>
                    <div className="flex flex-col gap-2 pt-2">
                        <Button onClick={() => { if (pendingSubmitData) submitLead(pendingSubmitData, 'update_contact'); }} disabled={loading}>{loading ? 'Saving...' : 'Update contact'}</Button>
                        <Button variant="outline" onClick={() => { if (pendingSubmitData) submitLead(pendingSubmitData, 'only_lead'); }} disabled={loading}>New contact</Button>
                        <Button variant="ghost" onClick={() => { setShowConfirmModal(false); setPendingSubmitData(null); }} disabled={loading}>Cancel</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

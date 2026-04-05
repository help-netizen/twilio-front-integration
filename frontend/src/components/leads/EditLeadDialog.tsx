import { useState, useEffect } from 'react';
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
import type { SavedAddress } from '../../services/contactsApi';
import type { UpdateLeadInput } from '../../types/lead';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { makeFormData, DEFAULT_JOB_TYPES, JOB_SOURCES } from './editLeadHelpers';
import type { EditLeadDialogProps } from './editLeadHelpers';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';

export function EditLeadDialog({ lead, open, onOpenChange, onSuccess }: EditLeadDialogProps) {
    const [loading, setLoading] = useState(false);
    const [showSecondary, setShowSecondary] = useState(!!(lead.SecondPhone || lead.SecondPhoneName));
    const { customFields: allFields, jobTypes: dynamicJobTypes } = useLeadFormSettings(open);
    const customFields = allFields.filter(f => !f.is_system);
    const jobTypes = dynamicJobTypes.length > 0 ? dynamicJobTypes : DEFAULT_JOB_TYPES;
    const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
    const [_selectedContactAddressId, setSelectedContactAddressId] = useState<number | null>(null);
    const [formData, setFormData] = useState<UpdateLeadInput>(() => makeFormData(lead));

    useEffect(() => {
        if (!open) return;
        if (lead.ContactId) contactsApi.getContactAddresses(lead.ContactId).then(res => setSavedAddresses(res.data.addresses)).catch(() => { });
    }, [open, lead.ContactId]);

    useEffect(() => { setFormData(makeFormData(lead)); }, [lead]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.FirstName || !formData.LastName || !formData.Phone) { toast.error('Please fill in required fields'); return; }
        setLoading(true);
        try { const submitData: UpdateLeadInput = { ...formData, Phone: toE164(formData.Phone), SecondPhone: formData.SecondPhone ? toE164(formData.SecondPhone) : '' }; await leadsApi.updateLead(lead.UUID, submitData); const detail = await leadsApi.getLeadByUUID(lead.UUID); onSuccess(detail.data.lead); }
        catch (error) { toast.error('Failed to update lead', { description: error instanceof Error ? error.message : 'Unknown error' }); }
        finally { setLoading(false); }
    };

    const updateMetadata = (apiName: string, value: string) => setFormData(prev => ({ ...prev, Metadata: { ...(prev.Metadata || {}), [apiName]: value } }));
    const update = (patch: Partial<UpdateLeadInput>) => setFormData(prev => ({ ...prev, ...patch }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Edit Lead - {lead.SerialId}</DialogTitle><DialogDescription>Make changes to the lead details below.</DialogDescription></DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="space-y-4"><h3 className="font-medium">Contact Information</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><Label htmlFor="firstName" className="mb-2">First Name <span className="text-destructive">*</span></Label><Input id="firstName" value={formData.FirstName} onChange={e => update({ FirstName: e.target.value })} required /></div><div><Label htmlFor="lastName" className="mb-2">Last Name <span className="text-destructive">*</span></Label><Input id="lastName" value={formData.LastName} onChange={e => update({ LastName: e.target.value })} required /></div></div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><Label htmlFor="phone" className="mb-2">Phone <span className="text-destructive">*</span></Label><PhoneInput id="phone" value={formData.Phone || ''} onChange={formatted => update({ Phone: formatted })} required /></div><div><Label htmlFor="email" className="mb-2">Email</Label><Input id="email" type="email" value={formData.Email} onChange={e => update({ Email: e.target.value })} /></div></div>
                        {!showSecondary ? <button type="button" onClick={() => setShowSecondary(true)} className="text-xs text-primary hover:underline">+ Secondary Phone</button> : <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><Label htmlFor="secondPhone" className="mb-2">Secondary Phone</Label><PhoneInput id="secondPhone" value={formData.SecondPhone || ''} onChange={formatted => update({ SecondPhone: formatted })} /></div><div><Label htmlFor="secondPhoneName" className="mb-2">Secondary Name</Label><Input id="secondPhoneName" value={formData.SecondPhoneName || ''} onChange={e => update({ SecondPhoneName: e.target.value })} placeholder="e.g. Tenant, Wife" /></div></div>}
                        <div><Label htmlFor="company" className="mb-2">Company</Label><Input id="company" value={formData.Company} onChange={e => update({ Company: e.target.value })} /></div>
                    </div>
                    <div className="space-y-4"><AddressAutocomplete header={<h3 className="font-medium">Address</h3>} idPrefix="edit-lead" defaultUseDetails={true} savedAddresses={savedAddresses} onSelectSaved={id => setSelectedContactAddressId(id)} value={{ street: formData.Address || '', apt: formData.Unit || '', city: formData.City || '', state: formData.State || '', zip: formData.PostalCode || '' }} onChange={addr => update({ Address: addr.street, Unit: addr.apt || '', City: addr.city, State: addr.state, PostalCode: addr.zip, Latitude: addr.lat ?? null, Longitude: addr.lng ?? null })} /></div>
                    <div className="space-y-4"><h3 className="font-medium">Job Details</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><Label htmlFor="jobType" className="mb-2">Job Type</Label><Select value={formData.JobType} onValueChange={v => update({ JobType: v })}><SelectTrigger id="jobType"><SelectValue placeholder="Select job type" /></SelectTrigger><SelectContent>{jobTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="jobSource" className="mb-2">Job Source</Label><Select value={formData.JobSource} onValueChange={v => update({ JobSource: v })}><SelectTrigger id="jobSource"><SelectValue placeholder="Select source" /></SelectTrigger><SelectContent>{JOB_SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></div></div>
                        <div><Label htmlFor="leadNotes" className="mb-2">Description</Label><Textarea id="leadNotes" value={formData.Description} onChange={e => update({ Description: e.target.value })} rows={4} className="min-h-[80px] resize-y" placeholder="Enter job description..." /></div>
                    </div>
                    {customFields.length > 0 && <div className="space-y-4"><h3 className="font-medium">Metadata</h3><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{customFields.map(field => <div key={field.id} className={field.field_type === 'textarea' || field.field_type === 'richtext' ? 'col-span-2' : ''}><Label htmlFor={`meta-${field.api_name}`} className="mb-2">{field.display_name}</Label>{field.field_type === 'textarea' || field.field_type === 'richtext' ? <Textarea id={`meta-${field.api_name}`} value={formData.Metadata?.[field.api_name] || ''} onChange={e => updateMetadata(field.api_name, e.target.value)} rows={3} /> : <Input id={`meta-${field.api_name}`} type={field.field_type === 'number' ? 'number' : 'text'} value={formData.Metadata?.[field.api_name] || ''} onChange={e => updateMetadata(field.api_name, e.target.value)} />}</div>)}</div></div>}
                    <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button><Button type="submit" disabled={loading}>{loading ? 'Saving...' : 'Save Changes'}</Button></DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

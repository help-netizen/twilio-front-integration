import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { PhoneInput, toE164 } from '../ui/PhoneInput';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
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
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        {`Edit lead${[formData.FirstName, formData.LastName].filter(Boolean).join(' ').trim() ? ` — ${[formData.FirstName, formData.LastName].filter(Boolean).join(' ').trim()}` : ''}`}
                    </DialogTitle>
                    <DialogDescription className="sr-only">Make changes to the lead details below.</DialogDescription>
                </DialogPanelHeader>

                <form onSubmit={handleSubmit} className="contents">
                    <DialogBody className="md:px-8 md:py-7">
                      <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {/* Contact */}
                        <div className="space-y-3.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingField id="firstName" label="First name" value={formData.FirstName} onChange={e => update({ FirstName: e.target.value })} />
                                <FloatingField id="lastName" label="Last name" value={formData.LastName} onChange={e => update({ LastName: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <PhoneInput id="phone" label="Phone" value={formData.Phone || ''} onChange={formatted => update({ Phone: formatted })} required />
                                <FloatingField id="email" label="Email" type="email" value={formData.Email} onChange={e => update({ Email: e.target.value })} />
                            </div>
                            {!showSecondary ? (
                                <button type="button" onClick={() => setShowSecondary(true)} className="justify-self-start text-xs text-primary hover:underline">+ Secondary Phone</button>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <PhoneInput id="secondPhone" label="Secondary phone" value={formData.SecondPhone || ''} onChange={formatted => update({ SecondPhone: formatted })} />
                                    <FloatingField id="secondPhoneName" label="Secondary name" value={formData.SecondPhoneName || ''} onChange={e => update({ SecondPhoneName: e.target.value })} />
                                </div>
                            )}
                            <FloatingField id="company" label="Company" value={formData.Company} onChange={e => update({ Company: e.target.value })} />
                        </div>

                        {/* Address */}
                        <AddressAutocomplete idPrefix="edit-lead" defaultUseDetails={true} hideDetailsToggle savedAddresses={savedAddresses} onSelectSaved={id => setSelectedContactAddressId(id)} value={{ street: formData.Address || '', apt: formData.Unit || '', city: formData.City || '', state: formData.State || '', zip: formData.PostalCode || '' }} onChange={addr => update({ Address: addr.street, Unit: addr.apt || '', City: addr.city, State: addr.state, PostalCode: addr.zip, Latitude: addr.lat ?? null, Longitude: addr.lng ?? null })} />

                        {/* Job details */}
                        <div className="space-y-3.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                <FloatingSelect id="jobType" label="Job type" value={formData.JobType} onValueChange={v => update({ JobType: v })}>
                                    {jobTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                                </FloatingSelect>
                                <FloatingSelect id="jobSource" label="Job source" value={formData.JobSource} onValueChange={v => update({ JobSource: v })}>
                                    {JOB_SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                </FloatingSelect>
                            </div>
                            <FloatingField id="leadNotes" label="Description" textarea rows={4} value={formData.Description} onChange={e => update({ Description: e.target.value })} />
                        </div>

                        {/* Metadata */}
                        {customFields.length > 0 && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                {customFields.map(field => (
                                    <div key={field.id} className={field.field_type === 'textarea' || field.field_type === 'richtext' ? 'sm:col-span-2' : ''}>
                                        <FloatingField
                                            id={`meta-${field.api_name}`}
                                            label={field.display_name}
                                            type={field.field_type === 'number' ? 'number' : 'text'}
                                            textarea={field.field_type === 'textarea' || field.field_type === 'richtext'}
                                            rows={3}
                                            value={formData.Metadata?.[field.api_name] || ''}
                                            onChange={e => updateMetadata(field.api_name, e.target.value)}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                      </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
                        <Button type="submit" disabled={loading}>{loading ? 'Saving...' : 'Save changes'}</Button>
                    </DialogPanelFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

import { useState, useEffect } from 'react';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { PhoneInput, toE164 } from '../ui/PhoneInput';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import { toast } from 'sonner';
import * as leadsApi from '../../services/leadsApi';
import type { Lead, CreateLeadInput } from '../../types/lead';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { useContactSearch, snapshotFromForm, hasFieldChanges } from './useContactSearch';
import './CreateLeadDialog.css';

interface CreateLeadDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: (lead: Lead) => void;
}

export const JOB_SOURCES = ['eLocals', 'ServiceDirect', 'Inquirly', 'Rely', 'LHG', 'NSA', 'Other'];

export function CreateLeadDialog({ open, onOpenChange, onSuccess }: CreateLeadDialogProps) {
    const [loading, setLoading] = useState(false);
    const [showSecondary, setShowSecondary] = useState(false);
    const [showCompany, setShowCompany] = useState(false);
    const { customFields: allFields, jobTypes: dynamicJobTypes } = useLeadFormSettings(open);
    const customFields = allFields.filter(f => !f.is_system);
    const jobTypes = dynamicJobTypes.length > 0 ? dynamicJobTypes : ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];
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
        if (!open) {
            cs.setCandidates([]); setSelectedContactId(null); cs.setSelectedName(''); setContactSnapshot(null);
            cs.setSavedAddresses([]); cs.setSelectedAddrId(null); cs.setShowDropdown(false);
            setShowConfirmModal(false); setPendingSubmitData(null);
            setShowSecondary(false); setShowCompany(false);
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
        if (!formData.FirstName || !formData.LastName || !formData.Phone || !formData.JobType) { toast.error('Please fill in required fields (including Job Type)'); return; }
        if (selectedContactId && contactSnapshot) {
            const current = snapshotFromForm(formData);
            if (hasFieldChanges(current, contactSnapshot)) { setPendingSubmitData(formData); setShowConfirmModal(true); return; }
        }
        await submitLead(formData, selectedContactId ? 'attach' : 'create_new');
    };

    const updateMetadata = (apiName: string, value: string) => setFormData(prev => ({ ...prev, Metadata: { ...(prev.Metadata || {}), [apiName]: value } }));

    // Reveal company if it has data (e.g. from contact autofill)
    const companyVisible = showCompany || !!formData.Company;

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent variant="panel">
                    {/* ── Header ── */}
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            New lead
                        </DialogTitle>
                        <DialogDescription className="sr-only">Create a new lead</DialogDescription>
                    </DialogPanelHeader>

                    {/* ── Scrollable body ── */}
                    <form id="create-lead-form" onSubmit={handleSubmit} className="contents">
                        <DialogBody className="md:px-8 md:py-7">
                          <div className="mx-auto w-full max-w-[740px] space-y-6">

                            {/* ── Contact ── */}
                            <div className="space-y-3.5" ref={cs.dropdownRef}>
                                {cs.renderSelectedBadge(selectedContactId, handleRemoveContact)}
                                {cs.renderSoftWarning()}

                                <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <FloatingField id="cld-first" label="First Name" value={formData.FirstName} onChange={(e) => cs.handleFieldChange('FirstName', e.target.value)} />
                                    <FloatingField id="cld-last" label="Last Name" value={formData.LastName} onChange={(e) => cs.handleFieldChange('LastName', e.target.value)} />
                                    {cs.renderDropdown('name')}
                                </div>

                                <div className="relative grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <PhoneInput id="cld-phone" label="Phone" value={formData.Phone} onChange={(f) => cs.handleFieldChange('Phone', f)} required />
                                    <FloatingField id="cld-email" label="Email" type="email" value={formData.Email} onChange={(e) => cs.handleFieldChange('Email', e.target.value)} />
                                    {cs.renderDropdown('phone')}{cs.renderDropdown('email')}
                                </div>

                                {/* Progressive disclosure: secondary phone + company */}
                                {(showSecondary || companyVisible) && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                        {showSecondary && (
                                            <PhoneInput id="cld-second-phone" label="Secondary Phone" value={formData.SecondPhone || ''} onChange={(f) => setFormData({ ...formData, SecondPhone: f })} />
                                        )}
                                        {showSecondary && (
                                            <FloatingField id="cld-second-name" label="Secondary Name" value={formData.SecondPhoneName || ''} onChange={(e) => setFormData({ ...formData, SecondPhoneName: e.target.value })} />
                                        )}
                                        {companyVisible && !showSecondary && (
                                            <FloatingField id="cld-company" label="Company" value={formData.Company} onChange={(e) => setFormData({ ...formData, Company: e.target.value })} />
                                        )}
                                    </div>
                                )}
                                {companyVisible && showSecondary && (
                                    <FloatingField id="cld-company" label="Company" value={formData.Company} onChange={(e) => setFormData({ ...formData, Company: e.target.value })} />
                                )}

                                {(!showSecondary || !companyVisible) && (
                                    <div className="cld-extras">
                                        {!showSecondary && <button type="button" className="cld-extras__btn" onClick={() => setShowSecondary(true)}>+ Secondary phone</button>}
                                        {!companyVisible && <button type="button" className="cld-extras__btn" onClick={() => setShowCompany(true)}>+ Company</button>}
                                    </div>
                                )}
                            </div>

                            {/* ── Address ── */}
                            <AddressAutocomplete
                                idPrefix="create-lead"
                                defaultUseDetails={true}
                                hideDetailsToggle
                                savedAddresses={cs.savedAddresses}
                                onSelectSaved={(id) => cs.setSelectedAddrId(id)}
                                value={{ street: formData.Address || '', apt: formData.Unit || '', city: formData.City || '', state: formData.State || '', zip: formData.PostalCode || '' }}
                                onChange={(addr) => { cs.setSelectedAddrId(null); setFormData({ ...formData, Address: addr.street, Unit: addr.apt || '', City: addr.city, State: addr.state, PostalCode: addr.zip, Latitude: addr.lat ?? null, Longitude: addr.lng ?? null }); }}
                            />

                            {/* ── Job ── */}
                            <div className="space-y-3.5">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <FloatingSelect id="cld-job-type" label="Job type" value={formData.JobType} onValueChange={(v) => setFormData({ ...formData, JobType: v })}>
                                        {jobTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                                    </FloatingSelect>
                                    <FloatingSelect id="cld-job-source" label="Lead source" value={formData.JobSource} onValueChange={(v) => setFormData({ ...formData, JobSource: v })}>
                                        {JOB_SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                                    </FloatingSelect>
                                </div>
                                <FloatingField id="cld-description" label="Description" textarea rows={3} value={formData.Description} onChange={(e) => setFormData({ ...formData, Description: e.target.value })} />
                            </div>

                            {/* ── Custom metadata (only if fields configured) ── */}
                            {customFields.length > 0 && (
                                <div className="space-y-3.5">
                                    <div className="cld-eyebrow">Additional info</div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                        {customFields.map(field => {
                                            const isLong = field.field_type === 'textarea' || field.field_type === 'richtext';
                                            return isLong
                                                ? <FloatingField key={field.id} id={`cld-meta-${field.api_name}`} label={field.display_name} textarea rows={3} className="sm:col-span-2" value={formData.Metadata?.[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} />
                                                : <FloatingField key={field.id} id={`cld-meta-${field.api_name}`} label={field.display_name} type={field.field_type === 'number' ? 'number' : 'text'} inputMode={field.field_type === 'number' ? 'decimal' : undefined} value={formData.Metadata?.[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} />;
                                        })}
                                    </div>
                                </div>
                            )}

                          </div>
                        </DialogBody>

                        {/* ── Footer ── */}
                        <DialogPanelFooter>
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
                            <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Lead'}</Button>
                        </DialogPanelFooter>
                    </form>
                </DialogContent>
            </Dialog>

            {/* ── Contact update confirmation ── */}
            <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
                <DialogContent className="cld-confirm max-w-[380px]">
                    <DialogHeader>
                        <DialogTitle>Update contact?</DialogTitle>
                        <DialogDescription>You changed some fields. Apply these changes to the existing contact too?</DialogDescription>
                    </DialogHeader>
                    <div className="cld-confirm__actions">
                        <Button onClick={() => { if (pendingSubmitData) submitLead(pendingSubmitData, 'update_contact'); }} disabled={loading}>{loading ? 'Saving...' : 'Update contact'}</Button>
                        <Button variant="outline" onClick={() => { if (pendingSubmitData) submitLead(pendingSubmitData, 'only_lead'); }} disabled={loading}>Keep separate</Button>
                        <Button variant="ghost" onClick={() => { setShowConfirmModal(false); setPendingSubmitData(null); }} disabled={loading}>Cancel</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

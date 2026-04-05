import { useState, useEffect } from 'react';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { PhoneInput, toE164 } from '../ui/PhoneInput';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
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

const JOB_SOURCES = ['eLocals', 'ServiceDirect', 'Inquirly', 'Rely', 'LHG', 'NSA', 'Other'];

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
        if (!formData.FirstName || !formData.LastName || !formData.Phone) { toast.error('Please fill in required fields'); return; }
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
                <DialogContent className="cld-dialog max-w-[560px] max-h-[88vh] p-0 overflow-hidden flex flex-col">
                    {/* ── Header ── */}
                    <DialogHeader className="cld-header">
                        <DialogTitle className="cld-header__title">New Lead</DialogTitle>
                        <DialogDescription className="sr-only">Create a new lead</DialogDescription>
                    </DialogHeader>

                    {/* ── Scrollable body ── */}
                    <form onSubmit={handleSubmit} className="cld-body">

                        {/* ── Contact ── */}
                        <div className="cld-section" ref={cs.dropdownRef}>
                            {cs.renderSelectedBadge(selectedContactId, handleRemoveContact)}
                            {cs.renderSoftWarning()}

                            <div className="cld-row" style={{ position: 'relative' }}>
                                <div className="cld-field">
                                    <label className="cld-label">First Name<span className="cld-label__req">*</span></label>
                                    <Input value={formData.FirstName} onChange={(e) => cs.handleFieldChange('FirstName', e.target.value)} required />
                                </div>
                                <div className="cld-field">
                                    <label className="cld-label">Last Name<span className="cld-label__req">*</span></label>
                                    <Input value={formData.LastName} onChange={(e) => cs.handleFieldChange('LastName', e.target.value)} required />
                                </div>
                                {cs.renderDropdown('name')}
                            </div>

                            <div className="cld-row" style={{ position: 'relative' }}>
                                <div className="cld-field">
                                    <label className="cld-label">Phone<span className="cld-label__req">*</span></label>
                                    <PhoneInput value={formData.Phone} onChange={(f) => cs.handleFieldChange('Phone', f)} required />
                                </div>
                                <div className="cld-field">
                                    <label className="cld-label">Email</label>
                                    <Input type="email" value={formData.Email} onChange={(e) => cs.handleFieldChange('Email', e.target.value)} />
                                </div>
                                {cs.renderDropdown('phone')}{cs.renderDropdown('email')}
                            </div>

                            {/* Progressive disclosure: secondary phone + company */}
                            {(showSecondary || companyVisible) && (
                                <div className="cld-row">
                                    {showSecondary && (
                                        <div className="cld-field">
                                            <label className="cld-label">Secondary Phone</label>
                                            <PhoneInput value={formData.SecondPhone || ''} onChange={(f) => setFormData({ ...formData, SecondPhone: f })} />
                                        </div>
                                    )}
                                    {showSecondary && (
                                        <div className="cld-field">
                                            <label className="cld-label">Secondary Name</label>
                                            <Input value={formData.SecondPhoneName || ''} onChange={(e) => setFormData({ ...formData, SecondPhoneName: e.target.value })} placeholder="e.g. Tenant, Wife" />
                                        </div>
                                    )}
                                    {companyVisible && !showSecondary && (
                                        <div className="cld-field">
                                            <label className="cld-label">Company</label>
                                            <Input value={formData.Company} onChange={(e) => setFormData({ ...formData, Company: e.target.value })} />
                                        </div>
                                    )}
                                </div>
                            )}
                            {companyVisible && showSecondary && (
                                <div className="cld-row">
                                    <div className="cld-field">
                                        <label className="cld-label">Company</label>
                                        <Input value={formData.Company} onChange={(e) => setFormData({ ...formData, Company: e.target.value })} />
                                    </div>
                                </div>
                            )}

                            {(!showSecondary || !companyVisible) && (
                                <div className="cld-extras">
                                    {!showSecondary && <button type="button" className="cld-extras__btn" onClick={() => setShowSecondary(true)}>+ Secondary phone</button>}
                                    {!companyVisible && <button type="button" className="cld-extras__btn" onClick={() => setShowCompany(true)}>+ Company</button>}
                                </div>
                            )}
                        </div>

                        {/* ── Address ── */}
                        <div className="cld-section">
                            <AddressAutocomplete
                                header={<div className="cld-eyebrow">Address</div>}
                                idPrefix="create-lead"
                                defaultUseDetails={true}
                                savedAddresses={cs.savedAddresses}
                                onSelectSaved={(id) => cs.setSelectedAddrId(id)}
                                value={{ street: formData.Address || '', apt: formData.Unit || '', city: formData.City || '', state: formData.State || '', zip: formData.PostalCode || '' }}
                                onChange={(addr) => { cs.setSelectedAddrId(null); setFormData({ ...formData, Address: addr.street, Unit: addr.apt || '', City: addr.city, State: addr.state, PostalCode: addr.zip, Latitude: addr.lat ?? null, Longitude: addr.lng ?? null }); }}
                            />
                        </div>

                        {/* ── Job ── */}
                        <div className="cld-section">
                            <div className="cld-eyebrow">Job</div>
                            <div className="cld-row">
                                <div className="cld-field">
                                    <label className="cld-label">Type</label>
                                    <Select value={formData.JobType} onValueChange={(v) => setFormData({ ...formData, JobType: v })}>
                                        <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                                        <SelectContent>{jobTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                                    </Select>
                                </div>
                                <div className="cld-field">
                                    <label className="cld-label">Source</label>
                                    <Select value={formData.JobSource} onValueChange={(v) => setFormData({ ...formData, JobSource: v })}>
                                        <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                                        <SelectContent>{JOB_SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <div className="cld-field">
                                <label className="cld-label">Description</label>
                                <Textarea value={formData.Description} onChange={(e) => setFormData({ ...formData, Description: e.target.value })} rows={2} placeholder="Additional notes..." />
                            </div>
                        </div>

                        {/* ── Custom metadata (only if fields configured) ── */}
                        {customFields.length > 0 && (
                            <div className="cld-section">
                                <div className="cld-eyebrow">Additional info</div>
                                <div className="cld-row">
                                    {customFields.map(field => (
                                        <div key={field.id} className={`cld-field ${field.field_type === 'textarea' || field.field_type === 'richtext' ? 'cld-field--full' : ''}`}>
                                            <label className="cld-label">{field.display_name}</label>
                                            {field.field_type === 'textarea' || field.field_type === 'richtext'
                                                ? <Textarea value={formData.Metadata?.[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} rows={2} />
                                                : <Input type={field.field_type === 'number' ? 'number' : 'text'} value={formData.Metadata?.[field.api_name] || ''} onChange={(e) => updateMetadata(field.api_name, e.target.value)} />
                                            }
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* ── Footer ── */}
                        <div className="cld-footer" style={{ padding: '14px 0 4px' }}>
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
                            <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create Lead'}</Button>
                        </div>
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

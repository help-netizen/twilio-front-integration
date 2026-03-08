import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';
import * as leadsApi from '../../services/leadsApi';
import { authedFetch } from '../../services/apiClient';
import type { ServiceAreaResult, Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import * as zenbookerApi from '../../services/zenbookerApi';
import { type AddressFields, EMPTY_ADDRESS } from '../AddressAutocomplete';

export type Step = 1 | 2 | 3 | 4;

export interface CustomFieldDef { id: string; display_name: string; api_name: string; field_type: string; is_system: boolean; sort_order: number; }

export const STEP_TITLES: Record<Step, string> = { 1: 'Customer & Address', 2: 'Service', 3: 'Timeslot', 4: 'Review & Confirm' };

export function useConvertToJob(lead: Lead, open: boolean, onSuccess: (lead: Lead) => void, onOpenChange: (open: boolean) => void) {
    const navigate = useNavigate();
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [addressFields, setAddressFields] = useState<AddressFields>(EMPTY_ADDRESS);
    const [territoryResult, setTerritoryResult] = useState<ServiceAreaResult | null>(null);
    const [territoryLoading, setTerritoryLoading] = useState(false);
    const [territoryError, setTerritoryError] = useState('');
    const [serviceName, setServiceName] = useState('');
    const [serviceDescription, setServiceDescription] = useState('');
    const [servicePrice, setServicePrice] = useState('0');
    const [serviceDuration, setServiceDuration] = useState('120');
    const [selectedDate, setSelectedDate] = useState('');
    const [timeslotDays, setTimeslotDays] = useState<TimeslotDay[]>([]);
    const [selectedTimeslot, setSelectedTimeslot] = useState<Timeslot | null>(null);
    const [timeslotsLoading, setTimeslotsLoading] = useState(false);
    const [timeslotsError, setTimeslotsError] = useState('');
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
    const [jobTypes, setJobTypes] = useState<string[]>([]);
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);

    useEffect(() => { if (!open) return; authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => { if (data.success) { if (data.jobTypes?.length) setJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name)); if (data.customFields) setCustomFields(data.customFields.filter((f: CustomFieldDef) => !f.is_system)); } }).catch(() => { }); }, [open]);

    useEffect(() => {
        if (open && lead) {
            setStep(1); setName([lead.FirstName, lead.LastName].filter(Boolean).join(' ') || ''); setPhone(lead.Phone || ''); setEmail(lead.Email || '');
            setAddressFields({ street: lead.Address || '', apt: lead.Unit || '', city: lead.City || '', state: lead.State || '', zip: lead.PostalCode || '', lat: lead.Latitude != null ? Number(lead.Latitude) : null, lng: lead.Longitude != null ? Number(lead.Longitude) : null });
            setServiceName(lead.JobType || 'General Service'); setServiceDescription(lead.Description || lead.Comments || ''); setServicePrice('0'); setServiceDuration('120');
            setTerritoryResult(null); setTerritoryError(''); setTimeslotDays([]); setSelectedTimeslot(null); setTimeslotsError('');
            const leadLat = lead.Latitude != null ? Number(lead.Latitude) : null; const leadLng = lead.Longitude != null ? Number(lead.Longitude) : null;
            setCoords(leadLat && leadLng ? { lat: leadLat, lng: leadLng } : null);
            setSelectedDate(new Date().toISOString().split('T')[0]);
        }
    }, [open, lead]);

    const checkTerritory = useCallback(async (zip: string) => { if (!zip || zip.length < 3) { setTerritoryResult(null); setTerritoryError(''); return; } setTerritoryLoading(true); setTerritoryError(''); try { const result = await zenbookerApi.checkServiceArea(zip); setTerritoryResult(result); if (result.customer_location?.coordinates) setCoords(result.customer_location.coordinates); if (!result.in_service_area) setTerritoryError('Postal code is not in any service area'); } catch (err) { setTerritoryError(err instanceof Error ? err.message : 'Service area check failed'); setTerritoryResult(null); } finally { setTerritoryLoading(false); } }, []);

    useEffect(() => { const timer = setTimeout(() => { if (addressFields.zip.trim().length >= 4) checkTerritory(addressFields.zip.trim()); }, 600); return () => clearTimeout(timer); }, [addressFields.zip, checkTerritory]);

    const fetchTimeslots = useCallback(async () => { const territoryId = territoryResult?.service_territory?.id; if (!territoryId || !selectedDate) return; setTimeslotsLoading(true); setTimeslotsError(''); setSelectedTimeslot(null); try { const result = await zenbookerApi.getTimeslots({ territory: territoryId, date: selectedDate, duration: Number(serviceDuration) || 120, days: 7, lat: coords?.lat, lng: coords?.lng }); setTimeslotDays(result.days || []); if (!result.days?.length || result.days.every(d => !d.timeslots?.length)) setTimeslotsError('No available timeslots for this date range'); } catch (err) { setTimeslotsError(err instanceof Error ? err.message : 'Failed to load timeslots'); setTimeslotDays([]); } finally { setTimeslotsLoading(false); } }, [territoryResult, selectedDate, serviceDuration, coords]);

    useEffect(() => { if (step === 3) fetchTimeslots(); }, [step, fetchTimeslots]);

    const handleSubmit = async () => {
        const territoryId = territoryResult?.service_territory?.id; if (!territoryId || !selectedTimeslot) return;
        setSubmitting(true);
        try {
            const zbJobPayload = { territory_id: territoryId, timeslot_id: selectedTimeslot.id, customer: { name: name || 'Unknown', ...(phone && { phone }), ...(email && { email }) }, address: { ...(addressFields.street && { line1: addressFields.street }), ...(addressFields.apt && { line2: addressFields.apt }), ...(addressFields.city && { city: addressFields.city }), ...(addressFields.state && { state: addressFields.state }), ...(addressFields.zip && { postal_code: addressFields.zip }), country: 'US' }, services: [{ custom_service: { name: serviceName || 'General Service', description: serviceDescription || '', price: Number(servicePrice) || 0, duration: Number(serviceDuration) || 120, taxable: false } }], assignment_method: 'auto', sms_notifications: true, email_notifications: true };
            const result = await leadsApi.convertLead(lead.UUID, { zb_job_payload: zbJobPayload, service: { name: serviceName, description: serviceDescription }, customer: { name, phone, email }, address: { line1: addressFields.street, line2: addressFields.apt, city: addressFields.city, state: addressFields.state, postal_code: addressFields.zip } });
            const jobId = result.data?.job_id; const zbJobId = result.data?.zenbooker_job_id;
            toast.success('Job created', { description: zbJobId ? `Zenbooker Job: ${zbJobId}` : `Local Job #${jobId}`, duration: 10000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/${jobId}`) } : undefined });
            onSuccess({ ...lead, Status: 'Converted' }); onOpenChange(false);
        } catch (err) { toast.error('Failed to create job', { description: err instanceof Error ? err.message : 'Unknown error' }); }
        finally { setSubmitting(false); }
    };

    const canProceedStep1 = !!(addressFields.zip.trim() && territoryResult?.in_service_area && name.trim());
    const canProceedStep2 = !!(serviceName.trim() && Number(serviceDuration) > 0);
    const canProceedStep3 = !!selectedTimeslot;

    return {
        step, setStep, submitting, name, setName, phone, setPhone, email, setEmail,
        addressFields, setAddressFields, territoryResult, territoryLoading, territoryError,
        serviceName, setServiceName, serviceDescription, setServiceDescription, servicePrice, setServicePrice,
        serviceDuration, setServiceDuration, selectedDate, setSelectedDate, timeslotDays, selectedTimeslot, setSelectedTimeslot,
        timeslotsLoading, timeslotsError, coords, setCoords, jobTypes, customFields,
        fetchTimeslots, handleSubmit, canProceedStep1, canProceedStep2, canProceedStep3,
    };
}

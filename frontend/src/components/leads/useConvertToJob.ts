import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';
import * as leadsApi from '../../services/leadsApi';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import type { Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import * as zenbookerApi from '../../services/zenbookerApi';
import { type AddressFields, EMPTY_ADDRESS } from '../AddressAutocomplete';
import { useZipCheck } from '../../hooks/useZipCheck';
import { useAuth } from '../../auth/AuthProvider';
import { todayInTZ, tomorrowAtInTZ } from '../../utils/companyTime';

export type Step = 1 | 2 | 3 | 4;

export type { CustomFieldDef } from '../../hooks/useLeadFormSettings';

export const STEP_TITLES: Record<Step, string> = { 1: 'Customer & Address', 2: 'Service', 3: 'Available Timeslots', 4: 'Review & Confirm' };

export function useConvertToJob(lead: Lead, open: boolean, onSuccess: (lead: Lead) => void, onOpenChange: (open: boolean) => void) {
    const navigate = useNavigate();
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [addressFields, setAddressFields] = useState<AddressFields>(EMPTY_ADDRESS);

    // Shared zip check hook — fast API for UI, Zenbooker in background for timeslots
    const zipCheck = useZipCheck(addressFields.zip);
    const { territoryResult, territoryLoading, territoryError, zipExists, zipArea, zipSource, coords, setCoords } = zipCheck;

    const [serviceName, setServiceName] = useState('');
    const [serviceDescription, setServiceDescription] = useState('');
    const [servicePrice, setServicePrice] = useState('0');
    const [serviceDuration, setServiceDuration] = useState('60');
    const [selectedDate, setSelectedDate] = useState('');
    const [timeslotDays, setTimeslotDays] = useState<TimeslotDay[]>([]);
    const [selectedTimeslot, setSelectedTimeslot] = useState<Timeslot | null>(null);
    const [timeslotsLoading, setTimeslotsLoading] = useState(false);
    const [timeslotsError, setTimeslotsError] = useState('');
    const { jobTypes, customFields } = useLeadFormSettings(open);

    useEffect(() => {
        if (open && lead) {
            setStep(1); setName([lead.FirstName, lead.LastName].filter(Boolean).join(' ') || ''); setPhone(lead.Phone || ''); setEmail(lead.Email || '');
            setAddressFields({ street: lead.Address || '', apt: lead.Unit || '', city: lead.City || '', state: lead.State || '', zip: lead.PostalCode || '', lat: lead.Latitude != null ? Number(lead.Latitude) : null, lng: lead.Longitude != null ? Number(lead.Longitude) : null });
            setServiceName(lead.JobType || 'General Service'); setServiceDescription(lead.Description || lead.Comments || ''); setServicePrice('0'); setServiceDuration('120');
            setTimeslotDays([]); setSelectedTimeslot(null); setTimeslotsError('');
            const leadLat = lead.Latitude != null ? Number(lead.Latitude) : null; const leadLng = lead.Longitude != null ? Number(lead.Longitude) : null;
            if (leadLat && leadLng) setCoords({ lat: leadLat, lng: leadLng });
            setSelectedDate(todayInTZ(companyTz));
        }
    }, [open, lead, setCoords]);

    const fetchTimeslots = useCallback(async () => { const territoryId = territoryResult?.service_territory?.id; if (!territoryId || !selectedDate) return; setTimeslotsLoading(true); setTimeslotsError(''); setSelectedTimeslot(null); try { const result = await zenbookerApi.getTimeslots({ territory: territoryId, date: selectedDate, duration: Number(serviceDuration) || 120, days: 7, lat: coords?.lat, lng: coords?.lng }); setTimeslotDays(result.days || []); if (!result.days?.length || result.days.every(d => !d.timeslots?.length)) setTimeslotsError('No available timeslots for this date range'); } catch (err) { setTimeslotsError(err instanceof Error ? err.message : 'Failed to load timeslots'); setTimeslotDays([]); } finally { setTimeslotsLoading(false); } }, [territoryResult, selectedDate, serviceDuration, coords]);

    useEffect(() => { if (step === 3) fetchTimeslots(); }, [step, fetchTimeslots]);

    const handleSubmit = async () => {
        const territoryId = territoryResult?.service_territory?.id; if (!territoryId || !selectedTimeslot) return;
        setSubmitting(true);
        try {
            const isCustom = selectedTimeslot.type === 'arrival_window';
            const zbJobPayload: Record<string, any> = {
                territory_id: territoryId,
                customer: { name: name || 'Unknown', ...(phone && { phone }), ...(email && { email }) },
                address: { ...(addressFields.street && { line1: addressFields.street }), ...(addressFields.apt && { line2: addressFields.apt }), ...(addressFields.city && { city: addressFields.city }), ...(addressFields.state && { state: addressFields.state }), ...(addressFields.zip && { postal_code: addressFields.zip }), country: 'US' },
                services: [{ custom_service: { name: serviceName || 'General Service', description: serviceDescription || '', price: Number(servicePrice) || 0, duration: Number(serviceDuration) || 120, taxable: false } }],
                sms_notifications: true, email_notifications: true,
            };
            if (selectedTimeslot.id) {
                // Zenbooker timeslot — use timeslot_id
                zbJobPayload.timeslot_id = selectedTimeslot.id;
                zbJobPayload.assignment_method = 'auto';
            } else if (isCustom) {
                // Custom timeslot — use timeslot object (same as Wizard)
                zbJobPayload.timeslot = { type: 'arrival_window', start: selectedTimeslot.start, end: selectedTimeslot.end };
                if (selectedTimeslot.techId) {
                    zbJobPayload.assigned_providers = [selectedTimeslot.techId];
                }
            } else {
                // Fallback — default arrival window (tomorrow 8am–12pm in company timezone)
                const tomorrowStart = tomorrowAtInTZ(8, 0, companyTz);
                const tomorrowEnd = new Date(tomorrowStart.getTime() + 4 * 60 * 60 * 1000);
                zbJobPayload.timeslot = { type: 'arrival_window', start: tomorrowStart.toISOString(), end: tomorrowEnd.toISOString() };
                zbJobPayload.assignment_method = 'auto';
            }
            const result = await leadsApi.convertLead(lead.UUID, { zb_job_payload: zbJobPayload, service: { name: serviceName, description: serviceDescription }, customer: { name, phone, email }, address: { line1: addressFields.street, line2: addressFields.apt, city: addressFields.city, state: addressFields.state, postal_code: addressFields.zip } });
            const jobId = result.data?.job_id; const zbJobId = result.data?.zenbooker_job_id;
            toast.success('Job created', { description: zbJobId ? `Zenbooker Job: ${zbJobId}` : `Local Job #${jobId}`, duration: 10000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/${jobId}`) } : undefined });
            onSuccess({ ...lead, Status: 'Converted' }); onOpenChange(false);
        } catch (err) { toast.error('Failed to create job', { description: err instanceof Error ? err.message : 'Unknown error' }); }
        finally { setSubmitting(false); }
    };

    const canProceedStep1 = !!(addressFields.zip.trim() && zipExists && name.trim());
    const canProceedStep2 = !!(serviceName.trim() && Number(serviceDuration) > 0);
    const canProceedStep3 = !!selectedTimeslot;

    return {
        step, setStep, submitting, name, setName, phone, setPhone, email, setEmail,
        addressFields, setAddressFields, territoryResult, territoryLoading, territoryError,
        zipExists, zipArea, zipSource,
        serviceName, setServiceName, serviceDescription, setServiceDescription, servicePrice, setServicePrice,
        serviceDuration, setServiceDuration, selectedDate, setSelectedDate, timeslotDays, selectedTimeslot, setSelectedTimeslot,
        timeslotsLoading, timeslotsError, coords, setCoords, jobTypes, customFields,
        fetchTimeslots, handleSubmit, canProceedStep1, canProceedStep2, canProceedStep3,
    };
}


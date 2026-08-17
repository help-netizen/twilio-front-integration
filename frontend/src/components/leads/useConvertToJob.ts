import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';
import * as leadsApi from '../../services/leadsApi';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { fetchSlotRecommendations, type SlotRecommendation } from '../../services/slotRecommendationsApi';
import { type AddressFields, EMPTY_ADDRESS } from '../AddressAutocomplete';
import { useZipCheck } from '../../hooks/useZipCheck';
import { useAuth } from '../../auth/AuthProvider';
import { todayInTZ, dateInTZ } from '../../utils/companyTime';
import { formatCompanyTime } from '../../lib/companyTime';

export type Step = 1 | 2 | 3 | 4;

export type { CustomFieldDef } from '../../hooks/useLeadFormSettings';

export const STEP_TITLES: Record<Step, string> = { 1: 'Customer & Address', 2: 'Service', 3: 'Schedule', 4: 'Review & Confirm' };

// ─── ZB-DECOUPLE C4b — native scheduling ─────────────────────────────────────
// The wizard used to fetch Zenbooker timeslots and submit a full ZB booking
// payload. It now picks from the NATIVE slot-recommendation engine (or a custom
// time via CustomTimeModal — also native) and submits a plain schedule; the
// server creates the local job only, no Zenbooker.

/** The wizard's picked schedule — an engine recommendation or a custom window. */
export interface SelectedSchedule {
    start: string;            // ISO (UTC)
    end: string;              // ISO (UTC)
    formatted: string;        // human label for the review step
    techId?: string | null;   // roster-compat technician id (engine/custom pick)
    techName?: string | null;
    source: 'engine' | 'custom';
}

/** 'YYYY-MM-DD' + 'HH:MM' wall-clock in the company tz → UTC ISO. */
function recTimeToISO(date: string, hhmm: string, tz: string): string {
    const [y, m, d] = date.split('-').map(Number);
    const [h, min] = hhmm.split(':').map(Number);
    return dateInTZ(y, m, d, h, min, tz).toISOString();
}

export function slotRecommendationToSchedule(rec: SlotRecommendation, tz: string): SelectedSchedule {
    const start = recTimeToISO(rec.date, rec.time_frame.start, tz);
    const end = recTimeToISO(rec.date, rec.time_frame.end, tz);
    const day = formatCompanyTime(`${rec.date}T12:00:00`, { weekday: 'short', month: 'short', day: 'numeric' }, tz);
    const tech = rec.technicians?.[0] || null;
    return {
        start,
        end,
        formatted: `${day}, ${rec.time_frame.start}–${rec.time_frame.end}${tech ? ` · ${tech.name}` : ''}`,
        techId: tech?.id ?? null,
        techName: tech?.name ?? null,
        source: 'engine',
    };
}

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

    // Local territory/zip check (service_territories table — no Zenbooker).
    const zipCheck = useZipCheck(addressFields.zip);
    const { territoryLoading, territoryError, zipExists, zipArea, zipSource, coords, setCoords } = zipCheck;

    const [serviceName, setServiceName] = useState('');
    const [serviceDescription, setServiceDescription] = useState('');
    const [servicePrice, setServicePrice] = useState('0');
    const [serviceDuration, setServiceDuration] = useState('60');
    const [selectedDate, setSelectedDate] = useState('');

    // Native slot recommendations (engine is optional — null until first fetch).
    const [recommendations, setRecommendations] = useState<SlotRecommendation[]>([]);
    const [engineEnabled, setEngineEnabled] = useState<boolean | null>(null);
    const [recsLoading, setRecsLoading] = useState(false);
    const [recsError, setRecsError] = useState('');
    const [selectedSchedule, setSelectedSchedule] = useState<SelectedSchedule | null>(null);
    const { jobTypes, customFields } = useLeadFormSettings(open);

    useEffect(() => {
        if (open && lead) {
            setStep(1); setName([lead.FirstName, lead.LastName].filter(Boolean).join(' ') || ''); setPhone(lead.Phone || ''); setEmail(lead.Email || '');
            setAddressFields({ street: lead.Address || '', apt: lead.Unit || '', city: lead.City || '', state: lead.State || '', zip: lead.PostalCode || '', lat: lead.Latitude != null ? Number(lead.Latitude) : null, lng: lead.Longitude != null ? Number(lead.Longitude) : null });
            setServiceName(lead.JobType || 'General Service'); setServiceDescription(lead.Description || lead.Comments || ''); setServicePrice('0'); setServiceDuration('120');
            setRecommendations([]); setEngineEnabled(null); setSelectedSchedule(null); setRecsError('');
            const leadLat = lead.Latitude != null ? Number(lead.Latitude) : null; const leadLng = lead.Longitude != null ? Number(lead.Longitude) : null;
            if (leadLat && leadLng) setCoords({ lat: leadLat, lng: leadLng });
            setSelectedDate(todayInTZ(companyTz));
        }
    }, [open, lead, setCoords]);

    const fetchRecommendations = useCallback(async () => {
        if (!selectedDate) return;
        setRecsLoading(true); setRecsError(''); setSelectedSchedule(prev => (prev?.source === 'custom' ? prev : null));
        try {
            const address = [addressFields.street, addressFields.city, addressFields.state, addressFields.zip].filter(Boolean).join(', ');
            const result = await fetchSlotRecommendations({
                lat: coords?.lat, lng: coords?.lng, address,
                duration_minutes: Number(serviceDuration) || 120,
                earliest_allowed_date: selectedDate,
            });
            setEngineEnabled(result.enabled);
            setRecommendations(result.recommendations);
            if (result.enabled && result.recommendations.length === 0) {
                setRecsError('No recommended slots for this date range — pick a custom time.');
            }
        } finally {
            setRecsLoading(false);
        }
    }, [selectedDate, serviceDuration, coords, addressFields]);

    useEffect(() => { if (step === 3) fetchRecommendations(); }, [step, fetchRecommendations]);

    const handleSubmit = async () => {
        if (!selectedSchedule) return;
        setSubmitting(true);
        try {
            const result = await leadsApi.convertLead(lead.UUID, {
                schedule: {
                    start_at: selectedSchedule.start,
                    end_at: selectedSchedule.end,
                    technician_ids: selectedSchedule.techId ? [selectedSchedule.techId] : [],
                },
                service: { name: serviceName, description: serviceDescription },
                customer: { name, phone, email },
                address: { line1: addressFields.street, line2: addressFields.apt, city: addressFields.city, state: addressFields.state, postal_code: addressFields.zip },
            });
            const jobId = result.data?.job_id;
            toast.success('Job created', { description: `Job #${jobId}`, duration: 10000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/by-id/${jobId}`) } : undefined });
            onSuccess({ ...lead, Status: 'Converted' }); onOpenChange(false);
        } catch (err) { toast.error('Failed to create job', { description: err instanceof Error ? err.message : 'Unknown error' }); }
        finally { setSubmitting(false); }
    };

    const canProceedStep1 = !!(addressFields.zip.trim() && zipExists && name.trim());
    const canProceedStep2 = !!(serviceName.trim() && Number(serviceDuration) > 0);
    const canProceedStep3 = !!selectedSchedule;

    return {
        step, setStep, submitting, name, setName, phone, setPhone, email, setEmail,
        addressFields, setAddressFields, territoryLoading, territoryError,
        zipExists, zipArea, zipSource,
        serviceName, setServiceName, serviceDescription, setServiceDescription, servicePrice, setServicePrice,
        serviceDuration, setServiceDuration, selectedDate, setSelectedDate,
        recommendations, engineEnabled, recsLoading, recsError, selectedSchedule, setSelectedSchedule,
        coords, setCoords, jobTypes, customFields, companyTz,
        fetchRecommendations, handleSubmit, canProceedStep1, canProceedStep2, canProceedStep3,
    };
}

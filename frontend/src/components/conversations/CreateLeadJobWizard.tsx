import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';
import { formatUSPhone, toE164 } from '../ui/PhoneInput';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import * as zenbookerApi from '../../services/zenbookerApi';
import * as leadsApi from '../../services/leadsApi';
import type { Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import { useZipCheck } from '../../hooks/useZipCheck';
import { ChevronRight, ChevronLeft, Phone } from 'lucide-react';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import type { Step } from './wizardTypes';
import { STEP_LABELS, DEFAULT_JOB_TYPES } from './wizardTypes';
import { WizardStep1 } from './WizardStep1';
import { WizardStep2 } from './WizardStep2';
import { WizardStep3 } from './WizardStep3';
import { WizardStep4 } from './WizardStep4';
import { useAuth } from '../../auth/AuthProvider';
import { todayInTZ, tomorrowAtInTZ } from '../../utils/companyTime';
import './CreateLeadJobWizard.css';

interface CreateLeadJobWizardProps {
    phone: string;
    hasActiveCall?: boolean;
    timelineId?: number;
    onLeadCreated?: () => void;
}

export function CreateLeadJobWizard({ phone, hasActiveCall: _hasActiveCall, timelineId, onLeadCreated }: CreateLeadJobWizardProps) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);
    const [showSkipConfirm, setShowSkipConfirm] = useState(false);


    const [territoryQuery, setTerritoryQuery] = useState(''); // full display text in territory input
    const [postalCode, setPostalCode] = useState('');        // zip/city for territory check
    const zipCheck = useZipCheck(postalCode);
    const { territoryResult, territoryLoading, territoryError, zipExists, zipArea, matchedZip, zipSource, zbLoading, coords, setCoords } = zipCheck;

    const [phoneNumber, setPhoneNumber] = useState(formatUSPhone(phone));
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [email, setEmail] = useState('');

    const [streetAddress, setStreetAddress] = useState('');
    const [unit, setUnit] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('MA');

    const { jobTypes: dynamicJobTypes } = useLeadFormSettings();
    const jobTypes = dynamicJobTypes.length > 0 ? dynamicJobTypes : DEFAULT_JOB_TYPES;
    const [jobType, setJobType] = useState('');
    const [description, setDescription] = useState('');
    const [duration, setDuration] = useState('60');
    const [price, setPrice] = useState('95');

    const [selectedDate, setSelectedDate] = useState('');
    const [timeslotDays, setTimeslotDays] = useState<TimeslotDay[]>([]);
    const [selectedTimeslot, setSelectedTimeslot] = useState<Timeslot | null>(null);
    const [timeslotsLoading, setTimeslotsLoading] = useState(false);
    const [timeslotsError, setTimeslotsError] = useState('');
    const [timeslotSkipped, setTimeslotSkipped] = useState(false);

    useEffect(() => { setSelectedDate(todayInTZ(companyTz)); }, []);
    // Note: Step 1 now uses AddressAutocomplete which fills streetAddress directly — no need to pre-fill from postalCode

    const fetchTimeslots = useCallback(async () => {
        const territoryId = territoryResult?.service_territory?.id;
        if (!territoryId || !selectedDate) return;
        setTimeslotsLoading(true); setTimeslotsError(''); setSelectedTimeslot(null);
        try {
            const result = await zenbookerApi.getTimeslots({ territory: territoryId, date: selectedDate, duration: Number(duration) || 120, days: 7, lat: coords?.lat, lng: coords?.lng });
            setTimeslotDays(result.days || []);
            if (!result.days?.length || result.days.every(d => !d.timeslots?.length)) setTimeslotsError('No available timeslots for this date range');
        } catch (err) { setTimeslotsError(err instanceof Error ? err.message : 'Failed to load timeslots'); setTimeslotDays([]); }
        finally { setTimeslotsLoading(false); }
    }, [territoryResult, selectedDate, duration, coords]);

    useEffect(() => { if (step === 3 && !timeslotSkipped) fetchTimeslots(); }, [step, fetchTimeslots, timeslotSkipped]);

    function formatPhone(p: string): string {
        const cleaned = p.replace(/\D/g, '');
        if (cleaned.length === 10) return `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
        if (cleaned.length === 11 && cleaned[0] === '1') return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
        return p;
    }

    const handleCreate = async (withJob: boolean) => {
        setSubmitting(true);
        try {
            // Geocode full address if coords are still null (use Places API — Geocoder is not enabled)
            let finalCoords = coords;
            if (!finalCoords?.lat || !finalCoords?.lng) {
                const fullAddress = [streetAddress, city, state, postalCode].filter(Boolean).join(', ');
                if (fullAddress && typeof google !== 'undefined' && google.maps?.places) {
                    try {
                        const tempDiv = document.createElement('div');
                        const placesService = new google.maps.places.PlacesService(tempDiv);
                        const loc = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
                            placesService.findPlaceFromQuery(
                                { query: fullAddress, fields: ['geometry'] },
                                (results, status) => {
                                    if (status === 'OK' && results?.[0]?.geometry?.location) {
                                        resolve({ lat: results[0].geometry.location.lat(), lng: results[0].geometry.location.lng() });
                                    } else { resolve(null); }
                                }
                            );
                        });
                        if (loc) {
                            finalCoords = loc;
                            setCoords(finalCoords);
                            console.log('[Wizard] Geocoded address via Places →', finalCoords);
                        }
                    } catch (err) { console.warn('[Wizard] Places geocode failed:', err); }
                }
            }

            const leadInput: Record<string, unknown> = {
                FirstName: firstName || 'Unknown', LastName: lastName || '', Phone: toE164(phoneNumber),
                Email: email || undefined, Address: streetAddress || undefined, Unit: unit || undefined,
                City: city || undefined, State: state || undefined, PostalCode: matchedZip || (/^\d/.test(postalCode) ? postalCode : undefined),
                Latitude: finalCoords?.lat || undefined, Longitude: finalCoords?.lng || undefined,
                JobType: jobType || undefined, Description: description || undefined,
                Status: withJob ? 'Converted' : 'Submitted', JobSource: 'Phone Call',
            };
            for (const k of Object.keys(leadInput)) { if (leadInput[k] === undefined) delete leadInput[k]; }
            const leadRes = await leadsApi.createLead(leadInput as any);
            const createdUUID = leadRes.data?.UUID;

            if (withJob && createdUUID) {
                const territoryId = territoryResult?.service_territory?.id;
                if (!territoryId) throw new Error('No territory for job creation — Zenbooker data not loaded yet');
                const zbJobPayload: Record<string, unknown> = {
                    territory_id: territoryId,
                    customer: { name: [firstName, lastName].filter(Boolean).join(' ') || 'Unknown', ...(phoneNumber && { phone: toE164(phoneNumber) }), ...(email && { email }) },
                    address: { line1: streetAddress || 'N/A', ...(unit && { line2: unit }), city: city || 'N/A', ...(state && { state }), ...((matchedZip || (/^\d/.test(postalCode) && postalCode)) && { postal_code: matchedZip || postalCode }), country: 'US' },
                    services: [{ custom_service: { name: jobType || 'General Service', description: description || '', price: Number(price) || 95, duration: Number(duration) || 120, taxable: false } }],
                    min_providers_needed: 1,
                    sms_notifications: true, email_notifications: true,
                };
                if (selectedTimeslot?.id) {
                    // Zenbooker timeslot — use timeslot_id
                    zbJobPayload.timeslot_id = selectedTimeslot.id;
                    zbJobPayload.assignment_method = 'auto';
                } else if (selectedTimeslot?.type === 'arrival_window') {
                    // Custom timeslot — use arrival window object
                    zbJobPayload.timeslot = { type: 'arrival_window', start: selectedTimeslot.start, end: selectedTimeslot.end };
                    if (selectedTimeslot.techId) {
                        // Pre-assign specific tech — must NOT have assignment_method:'auto'
                        zbJobPayload.assigned_providers = [selectedTimeslot.techId];
                    } else {
                        zbJobPayload.assignment_method = 'auto';
                    }
                } else {
                    // No timeslot — default arrival window (tomorrow 8am–12pm in company timezone)
                    const tomorrowStart = tomorrowAtInTZ(8, 0, companyTz);
                    const tomorrowEnd = new Date(tomorrowStart.getTime() + 4 * 60 * 60 * 1000);
                    zbJobPayload.timeslot = { type: 'arrival_window', start: tomorrowStart.toISOString(), end: tomorrowEnd.toISOString() };
                    zbJobPayload.assignment_method = 'auto';
                }
                const result = await leadsApi.convertLead(createdUUID, {
                    zb_job_payload: zbJobPayload, service: { name: jobType || 'General Service' },
                    customer: { name: [firstName, lastName].filter(Boolean).join(' ') || 'Unknown', phone: toE164(phoneNumber), email: email || undefined },
                    address: { line1: streetAddress, line2: unit, city, state, postal_code: matchedZip || (/^\d/.test(postalCode) ? postalCode : '') },
                    ...(timelineId ? { timeline_id: timelineId } : {}),
                });
                const jobId = result.data?.job_id;

                // Persist geocoded coords to the created job
                if (jobId && finalCoords?.lat && finalCoords?.lng) {
                    try {
                        const { updateJobCoords } = await import('../../services/jobsApi');
                        await updateJobCoords(jobId, finalCoords.lat, finalCoords.lng);
                        console.log('[Wizard] Saved coords to job', jobId, finalCoords);
                    } catch { /* non-critical */ }
                }

                const zbWarning = result.data?.zb_warning;
                if (zbWarning) {
                    toast.warning('Lead created but Zenbooker job failed', { description: zbWarning, duration: 15000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/${jobId}`) } : undefined });
                } else {
                    toast.success('Lead & Job created', { description: jobId ? `Job #${jobId}` : 'Job created', duration: 10000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/${jobId}`) } : undefined });
                }
            } else {
                toast.success('Lead created', { description: 'Status: Submitted' });
            }
            queryClient.invalidateQueries({ queryKey: ['lead-by-phone', phone] });
            onLeadCreated?.();
        } catch (err) { toast.error('Failed to create', { description: err instanceof Error ? err.message : 'Unknown error' }); }
        finally { setSubmitting(false); }
    };

    const canProceedStep1 = !!(postalCode.trim() && zipExists);
    const canProceedStep2 = !!(jobType.trim() && Number(duration) > 0);
    const canProceedStep3 = !!selectedTimeslot || timeslotSkipped;

    const ws = {
        territoryQuery, setTerritoryQuery, postalCode, setPostalCode, territoryResult, territoryLoading, territoryError, zipExists, zipArea, matchedZip, zipSource, zbLoading,
        firstName, setFirstName, lastName, setLastName, phoneNumber, setPhoneNumber, email, setEmail,
        jobTypes, jobType, setJobType, description, setDescription, duration, setDuration, price, setPrice,
        selectedDate, setSelectedDate, timeslotDays, selectedTimeslot, setSelectedTimeslot,
        timeslotsLoading, timeslotsError, timeslotSkipped, setTimeslotSkipped, fetchTimeslots,
        showSkipConfirm, setShowSkipConfirm,
        streetAddress, setStreetAddress, unit, setUnit, city, setCity, state, setState,
        coords, setCoords, submitting, handleCreate, setStep,
    };

    return (
        <div className="wizard">
            <div className="wizard__header">
                <div className="wizard__header-content">
                    <div className="wizard__header-left">
                        <div className="wizard__phone-row">
                            <Phone className="w-4" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span>{formatPhone(phone)}</span>
                            <ClickToCallButton phone={phone} contactName={firstName ? `${firstName} ${lastName}`.trim() : undefined} />
                            <OpenTimelineButton phone={phone} />
                        </div>
                    </div>
                </div>
            </div>
            <div className="wizard__steps">
                {([1, 2, 3, 4] as Step[]).map(s => (
                    <button
                        key={s}
                        type="button"
                        className={`wizard__step-pill${s === step ? ' wizard__step-pill--active' : s < step ? ' wizard__step-pill--done wizard__step-pill--clickable' : ''}`}
                        onClick={() => { if (s < step) setStep(s); }}
                        disabled={s > step}
                    >
                        {s < step ? `✓ ${STEP_LABELS[s]}` : STEP_LABELS[s]}
                    </button>
                ))}
            </div>
            {step === 1 && <WizardStep1 {...ws} />}
            {step === 2 && <WizardStep2 {...ws} />}
            {step === 3 && <WizardStep3 {...ws} />}
            {step === 4 && <WizardStep4 {...ws} />}
            {step < 4 && (
                <div className="wizard__nav">
                    <div>{step > 1 && <Button variant="outline" size="sm" onClick={() => setStep((step - 1) as Step)}><ChevronLeft className="w-4 mr-0.5" /> Back</Button>}</div>
                    <Button size="sm" onClick={() => setStep((step + 1) as Step)} disabled={(step === 1 && !canProceedStep1) || (step === 2 && !canProceedStep2) || (step === 3 && !canProceedStep3)}>
                        Next <ChevronRight className="w-4 ml-0.5" />
                    </Button>
                </div>
            )}
        </div>
    );
}

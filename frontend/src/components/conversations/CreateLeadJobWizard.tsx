import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';
import { formatUSPhone, toE164 } from '../ui/PhoneInput';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import * as leadsApi from '../../services/leadsApi';
import { fetchSlotRecommendations, type SlotRecommendation } from '../../services/slotRecommendationsApi';
import { type SelectedSchedule } from '../leads/useConvertToJob';
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
    // Optional: blank/undefined for an email-origin (phoneless) contact. When present, the wizard
    // behaves exactly as before (phone-origin). contactId/email prefill the email-origin flow.
    phone?: string;
    contactId?: number;
    email?: string;
    hasActiveCall?: boolean;
    timelineId?: number;
    onLeadCreated?: () => void;
}

export function CreateLeadJobWizard({ phone, contactId, email: emailProp, hasActiveCall: _hasActiveCall, timelineId, onLeadCreated }: CreateLeadJobWizardProps) {
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
    const { territoryLoading, territoryError, zipExists, zipArea, matchedZip, zipSource, coords, setCoords } = zipCheck;

    const [phoneNumber, setPhoneNumber] = useState(formatUSPhone(phone || ''));
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [email, setEmail] = useState(emailProp || '');

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
    // ZB-DECOUPLE C4b — native slot recommendations replace the ZB timeslot grid.
    const [recommendations, setRecommendations] = useState<SlotRecommendation[]>([]);
    const [engineEnabled, setEngineEnabled] = useState<boolean | null>(null);
    const [selectedSchedule, setSelectedSchedule] = useState<SelectedSchedule | null>(null);
    const [recsLoading, setRecsLoading] = useState(false);
    const [recsError, setRecsError] = useState('');
    const [timeslotSkipped, setTimeslotSkipped] = useState(false);

    useEffect(() => { setSelectedDate(todayInTZ(companyTz)); }, []);
    // Note: Step 1 now uses AddressAutocomplete which fills streetAddress directly — no need to pre-fill from postalCode

    const fetchRecommendations = useCallback(async () => {
        if (!selectedDate) return;
        setRecsLoading(true); setRecsError('');
        setSelectedSchedule(prev => (prev?.source === 'custom' ? prev : null));
        try {
            const address = [streetAddress, city, state, postalCode].filter(Boolean).join(', ');
            const result = await fetchSlotRecommendations({
                lat: coords?.lat, lng: coords?.lng, address,
                duration_minutes: Number(duration) || 120,
                earliest_allowed_date: selectedDate,
            });
            setEngineEnabled(result.enabled);
            setRecommendations(result.recommendations);
            if (result.enabled && result.recommendations.length === 0) {
                setRecsError('No recommended slots for this date range — pick a custom time or skip.');
            }
        } finally { setRecsLoading(false); }
    }, [selectedDate, duration, coords, streetAddress, city, state, postalCode]);

    useEffect(() => { if (step === 3 && !timeslotSkipped) fetchRecommendations(); }, [step, fetchRecommendations, timeslotSkipped]);

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

            const phoneE164 = toE164(phoneNumber);
            const leadInput: Record<string, unknown> = {
                FirstName: firstName || 'Unknown', LastName: lastName || '',
                // Phone only when non-blank — email-origin leads are stored phoneless (no fabricated phone).
                ...(phoneE164 ? { Phone: phoneE164 } : {}),
                Email: email || undefined, Address: streetAddress || undefined, Unit: unit || undefined,
                City: city || undefined, State: state || undefined, PostalCode: matchedZip || (/^\d/.test(postalCode) ? postalCode : undefined),
                Latitude: finalCoords?.lat || undefined, Longitude: finalCoords?.lng || undefined,
                JobType: jobType || undefined, Description: description || undefined,
                // Always Submitted, even when a job follows: convertLead below is
                // what turns the lead Converted, and it does so by linking the job
                // it creates. Claiming the end state here instead was fatal — the
                // row said Converted while converted_to_job was still false, which
                // mig245's CHECK refuses, so the INSERT rolled back and the lead
                // was never created at all (the operator then made the job by hand
                // and the channel attribution was lost).
                Status: 'Submitted', JobSource: 'Phone Call',
                // Link to the timeline's contact (attach = no dedup, no phone fabrication) when opened from a contact card.
                ...(contactId ? { selected_contact_id: contactId, contact_update_mode: 'attach' } : {}),
            };
            for (const k of Object.keys(leadInput)) { if (leadInput[k] === undefined) delete leadInput[k]; }
            const leadRes = await leadsApi.createLead(leadInput as any);
            const createdUUID = leadRes.data?.UUID;

            if (withJob && createdUUID) {
                // ZB-DECOUPLE C4b: native conversion — a plain schedule, no Zenbooker.
                // Skipped/absent pick falls back to tomorrow 8am–12pm (company tz),
                // same default window the ZB path used.
                let scheduleStart: string; let scheduleEnd: string; let techIds: string[] = [];
                if (selectedSchedule) {
                    scheduleStart = selectedSchedule.start;
                    scheduleEnd = selectedSchedule.end;
                    techIds = selectedSchedule.techId ? [selectedSchedule.techId] : [];
                } else {
                    const tomorrowStart = tomorrowAtInTZ(8, 0, companyTz);
                    const tomorrowEnd = new Date(tomorrowStart.getTime() + 4 * 60 * 60 * 1000);
                    scheduleStart = tomorrowStart.toISOString();
                    scheduleEnd = tomorrowEnd.toISOString();
                }
                const result = await leadsApi.convertLead(createdUUID, {
                    schedule: { start_at: scheduleStart, end_at: scheduleEnd, technician_ids: techIds },
                    service: { name: jobType || 'General Service', description: description || undefined },
                    customer: { name: [firstName, lastName].filter(Boolean).join(' ') || 'Unknown', ...(phoneNumber && { phone: toE164(phoneNumber) }), email: email || undefined },
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

                toast.success('Lead & Job created', { description: jobId ? `Job #${result.data?.job_seq ?? '—'}` : 'Job created', duration: 10000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/by-id/${jobId}`) } : undefined });
            } else {
                toast.success('Lead created', { description: 'Status: Submitted' });
            }
            queryClient.invalidateQueries({ queryKey: ['lead-by-phone', phone] });
            if (contactId) queryClient.invalidateQueries({ queryKey: ['lead-by-contact', contactId] });
            onLeadCreated?.();
        } catch (err) { toast.error('Failed to create', { description: err instanceof Error ? err.message : 'Unknown error' }); }
        finally { setSubmitting(false); }
    };

    const canProceedStep1 = !!(postalCode.trim() && zipExists);
    const canProceedStep2 = !!(jobType.trim() && Number(duration) > 0);
    const canProceedStep3 = !!selectedSchedule || timeslotSkipped;
    // Jobs from this wizard notify by SMS — keep requiring a phone for the with-job
    // leg. Email-origin (phoneless) → "Create Lead" only until a phone is typed.
    const canCreateJob = !!toE164(phoneNumber);

    const ws = {
        territoryQuery, setTerritoryQuery, postalCode, setPostalCode, territoryLoading, territoryError, zipExists, zipArea, matchedZip, zipSource,
        firstName, setFirstName, lastName, setLastName, phoneNumber, setPhoneNumber, email, setEmail,
        jobTypes, jobType, setJobType, description, setDescription, duration, setDuration, price, setPrice,
        selectedDate, setSelectedDate, recommendations, engineEnabled, selectedSchedule, setSelectedSchedule,
        recsLoading, recsError, timeslotSkipped, setTimeslotSkipped, fetchRecommendations,
        showSkipConfirm, setShowSkipConfirm,
        streetAddress, setStreetAddress, unit, setUnit, city, setCity, state, setState,
        coords, setCoords, submitting, handleCreate, setStep, canCreateJob, companyTz,
    };

    return (
        <div className="wizard">
            <div className="wizard__header">
                <div className="wizard__header-content">
                    <div className="wizard__header-left">
                        {phone && (
                            <div className="wizard__phone-row">
                                <Phone className="w-4" style={{ color: 'var(--blanc-ink-3)' }} />
                                <span>{formatPhone(phone)}</span>
                                <ClickToCallButton phone={phone} contactName={firstName ? `${firstName} ${lastName}`.trim() : undefined} />
                                <OpenTimelineButton phone={phone} />
                            </div>
                        )}
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

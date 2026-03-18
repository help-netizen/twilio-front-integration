import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/button';
import { formatUSPhone, toE164 } from '../ui/PhoneInput';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../services/apiClient';
import * as zenbookerApi from '../../services/zenbookerApi';
import * as leadsApi from '../../services/leadsApi';
import type { Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import { useZipCheck } from '../../hooks/useZipCheck';
import { ChevronRight, ChevronLeft, User, Phone } from 'lucide-react';
import type { Step } from './wizardTypes';
import { STEP_LABELS, DEFAULT_JOB_TYPES } from './wizardTypes';
import { WizardStep1 } from './WizardStep1';
import { WizardStep2 } from './WizardStep2';
import { WizardStep3 } from './WizardStep3';
import { WizardStep4 } from './WizardStep4';
import './CreateLeadJobWizard.css';

interface CreateLeadJobWizardProps {
    phone: string;
    hasActiveCall?: boolean;
    onLeadCreated?: () => void;
}

export function CreateLeadJobWizard({ phone, hasActiveCall, onLeadCreated }: CreateLeadJobWizardProps) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);
    const [showSkipConfirm, setShowSkipConfirm] = useState(false);
    const [confirmCall, setConfirmCall] = useState(false);

    const [postalCode, setPostalCode] = useState('');
    const zipCheck = useZipCheck(postalCode);
    const { territoryResult, territoryLoading, territoryError, zipExists, zipArea, zipSource, zbLoading, coords, setCoords } = zipCheck;

    const [phoneNumber, setPhoneNumber] = useState(formatUSPhone(phone));
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [email, setEmail] = useState('');

    const [streetAddress, setStreetAddress] = useState('');
    const [unit, setUnit] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('MA');

    const [jobTypes, setJobTypes] = useState<string[]>(DEFAULT_JOB_TYPES);
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

    useEffect(() => {
        authedFetch('/api/settings/lead-form').then(r => r.json()).then(data => {
            if (data.success && data.jobTypes?.length > 0) setJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name));
        }).catch(() => { });
    }, []);

    useEffect(() => { setSelectedDate(new Date().toISOString().split('T')[0]); }, []);
    useEffect(() => { if (step === 4 && postalCode && !streetAddress) setStreetAddress(postalCode + ' '); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

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
            const leadInput: Record<string, unknown> = {
                FirstName: firstName || 'Unknown', LastName: lastName || '', Phone: toE164(phoneNumber),
                Email: email || undefined, Address: streetAddress || undefined, Unit: unit || undefined,
                City: city || undefined, State: state || undefined, PostalCode: postalCode || undefined,
                Latitude: coords?.lat || undefined, Longitude: coords?.lng || undefined,
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
                    address: { line1: streetAddress || 'N/A', city: city || 'N/A', ...(state && { state }), ...(postalCode && { postal_code: postalCode }), country: 'US' },
                    services: [{ custom_service: { name: jobType || 'General Service', description: description || '', price: Number(price) || 95, duration: Number(duration) || 120, taxable: false } }],
                    assignment_method: 'auto', sms_notifications: true, email_notifications: true,
                };
                if (selectedTimeslot?.id) {
                    // Zenbooker timeslot — use timeslot_id
                    zbJobPayload.timeslot_id = selectedTimeslot.id;
                } else if (selectedTimeslot?.type === 'arrival_window') {
                    // Custom timeslot — use arrival window object
                    zbJobPayload.timeslot = { type: 'arrival_window', start: selectedTimeslot.start, end: selectedTimeslot.end };
                } else {
                    // No timeslot — default arrival window
                    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
                    const end = new Date(tomorrow.getTime() + 4 * 60 * 60 * 1000);
                    zbJobPayload.timeslot = { type: 'arrival_window', start: tomorrow.toISOString(), end: end.toISOString() };
                }
                const result = await leadsApi.convertLead(createdUUID, {
                    zb_job_payload: zbJobPayload, service: { name: jobType || 'General Service' },
                    customer: { name: [firstName, lastName].filter(Boolean).join(' ') || 'Unknown', phone: toE164(phoneNumber), email: email || undefined },
                    address: { line1: streetAddress, line2: unit, city, state, postal_code: postalCode },
                });
                const jobId = result.data?.job_id;
                toast.success('Lead & Job created', { description: jobId ? `Job #${jobId}` : 'Job created', duration: 10000, action: jobId ? { label: 'Open Job', onClick: () => navigate(`/jobs/${jobId}`) } : undefined });
            } else {
                toast.success('Lead created', { description: 'Status: Submitted' });
            }
            queryClient.invalidateQueries({ queryKey: ['lead-by-phone', phone] });
            onLeadCreated?.();
        } catch (err) { toast.error('Failed to create', { description: err instanceof Error ? err.message : 'Unknown error' }); }
        finally { setSubmitting(false); }
    };

    const canProceedStep1 = !!(postalCode.trim() && zipExists);
    const canProceedStep2 = !!(Number(duration) > 0);
    const canProceedStep3 = !!selectedTimeslot || timeslotSkipped;

    const ws = {
        postalCode, setPostalCode, territoryResult, territoryLoading, territoryError, zipExists, zipArea, zipSource, zbLoading,
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
                        <div className="wizard__avatar"><User className="wizard__avatar-icon" /></div>
                        <div><div className="wizard__title">New Lead / Job</div><div className="wizard__phone-row"><Phone className="w-3.5" /><span>{formatPhone(phone)}</span></div></div>
                    </div>
                    <div className="wizard__header-right">
                        {hasActiveCall ? (
                            <span className="wizard__call-btn wizard__call-btn--disabled" title="Someone is already on a call with this customer, try again later"><Phone className="w-4" /><span>Call</span></span>
                        ) : (
                            <button type="button" onClick={() => setConfirmCall(c => !c)} className="wizard__call-btn" title={`Call ${formatPhone(phone)}`}><Phone className="w-4" /><span>Call</span></button>
                        )}
                    </div>
                </div>
            </div>
            {confirmCall && (
                <div className="wizard__confirm-call">
                    <span className="wizard__confirm-label">Call {formatPhone(phone)}?</span>
                    <div className="wizard__confirm-actions">
                        <button type="button" className="wizard__confirm-cancel" onClick={() => setConfirmCall(false)}>Cancel</button>
                        <a href={`tel:${phone}`} className="wizard__confirm-btn" onClick={() => setConfirmCall(false)}><Phone className="w-4" /> Call Now</a>
                    </div>
                </div>
            )}
            <div className="wizard__steps">
                {([1, 2, 3, 4] as Step[]).map(s => (
                    <div key={s} className="wizard__step-item">
                        <div className={`wizard__step-circle ${s === step ? 'wizard__step-circle--active' : s < step ? 'wizard__step-circle--done' : ''}`}>{s < step ? '✓' : s}</div>
                        {s < 4 && <div className={`wizard__step-line ${s < step ? 'wizard__step-line--done' : ''}`} />}
                    </div>
                ))}
                <span className="wizard__step-label">{STEP_LABELS[step]}</span>
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

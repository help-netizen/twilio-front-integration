import { useState, useEffect, useCallback } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import * as zenbookerApi from '../../services/zenbookerApi';
import * as leadsApi from '../../services/leadsApi';
import type { ServiceAreaResult, Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import {
    MapPin, Briefcase, Calendar, Clock, DollarSign,
    ChevronRight, ChevronLeft, CheckCircle2, SkipForward,
    AlertTriangle, User, Phone, FileText,
} from 'lucide-react';
import './CreateLeadJobWizard.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateLeadJobWizardProps {
    phone: string;
    callCount?: number;
    /** Called after lead is created so the parent can refetch */
    onLeadCreated?: () => void;
}

type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
    1: 'Territory',
    2: 'Service',
    3: 'Schedule',
    4: 'Confirm',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function CreateLeadJobWizard({ phone, callCount, onLeadCreated }: CreateLeadJobWizardProps) {
    const queryClient = useQueryClient();
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);
    const [showSkipConfirm, setShowSkipConfirm] = useState(false);

    // Step 1 — zip code / territory
    const [postalCode, setPostalCode] = useState('');
    const [territoryResult, setTerritoryResult] = useState<ServiceAreaResult | null>(null);
    const [territoryLoading, setTerritoryLoading] = useState(false);
    const [territoryError, setTerritoryError] = useState('');
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

    // Customer info (editable, pre-filled where possible)
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [email, setEmail] = useState('');

    // Address
    const [streetAddress, setStreetAddress] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('MA');

    // Step 2 — service
    const [jobType, setJobType] = useState('');
    const [description, setDescription] = useState('');
    const [duration, setDuration] = useState('120');
    const [price, setPrice] = useState('95');

    // Step 3 — timeslots
    const [selectedDate, setSelectedDate] = useState('');
    const [timeslotDays, setTimeslotDays] = useState<TimeslotDay[]>([]);
    const [selectedTimeslot, setSelectedTimeslot] = useState<Timeslot | null>(null);
    const [timeslotsLoading, setTimeslotsLoading] = useState(false);
    const [timeslotsError, setTimeslotsError] = useState('');
    const [timeslotSkipped, setTimeslotSkipped] = useState(false);

    // Init default date
    useEffect(() => {
        const today = new Date();
        setSelectedDate(today.toISOString().split('T')[0]);
    }, []);

    // ── Territory check (debounced) ──
    const checkTerritory = useCallback(async (zip: string) => {
        if (!zip || zip.length < 3) {
            setTerritoryResult(null);
            setTerritoryError('');
            return;
        }
        setTerritoryLoading(true);
        setTerritoryError('');
        try {
            const result = await zenbookerApi.checkServiceArea(zip);
            setTerritoryResult(result);
            if (result.customer_location?.coordinates) {
                setCoords(result.customer_location.coordinates);
            }
            if (!result.in_service_area) {
                setTerritoryError('Zip code is not in any service area');
            }
        } catch (err) {
            setTerritoryError(err instanceof Error ? err.message : 'Service area check failed');
            setTerritoryResult(null);
        } finally {
            setTerritoryLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (postalCode.trim().length >= 4) {
                checkTerritory(postalCode.trim());
            }
        }, 600);
        return () => clearTimeout(timer);
    }, [postalCode, checkTerritory]);

    // ── Fetch timeslots ──
    const fetchTimeslots = useCallback(async () => {
        const territoryId = territoryResult?.service_territory?.id;
        if (!territoryId || !selectedDate) return;

        setTimeslotsLoading(true);
        setTimeslotsError('');
        setSelectedTimeslot(null);
        try {
            const result = await zenbookerApi.getTimeslots({
                territory: territoryId,
                date: selectedDate,
                duration: Number(duration) || 120,
                days: 7,
                lat: coords?.lat,
                lng: coords?.lng,
            });
            setTimeslotDays(result.days || []);
            if (!result.days?.length || result.days.every(d => !d.timeslots?.length)) {
                setTimeslotsError('No available timeslots for this date range');
            }
        } catch (err) {
            setTimeslotsError(err instanceof Error ? err.message : 'Failed to load timeslots');
            setTimeslotDays([]);
        } finally {
            setTimeslotsLoading(false);
        }
    }, [territoryResult, selectedDate, duration, coords]);

    useEffect(() => {
        if (step === 3 && !timeslotSkipped) {
            fetchTimeslots();
        }
    }, [step, fetchTimeslots, timeslotSkipped]);

    // ── Format phone for display ──
    function formatPhone(p: string): string {
        const cleaned = p.replace(/\D/g, '');
        if (cleaned.length === 10) return `+1 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
        if (cleaned.length === 11 && cleaned[0] === '1') return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
        return p;
    }

    // ── Submit ──
    const handleCreate = async (withJob: boolean) => {
        setSubmitting(true);
        try {
            // 1. Create lead
            const leadInput: Record<string, unknown> = {
                FirstName: firstName || 'Unknown',
                LastName: lastName || '',
                Phone: phone,
                Email: email || undefined,
                Address: streetAddress || undefined,
                City: city || undefined,
                State: state || undefined,
                PostalCode: postalCode || undefined,
                JobType: jobType || undefined,
                LeadNotes: description || undefined,
                Status: withJob ? 'Converted' : 'Submitted',
                JobSource: 'Phone Call',
            };

            // Clean undefined
            for (const k of Object.keys(leadInput)) {
                if (leadInput[k] === undefined) delete leadInput[k];
            }

            const leadRes = await leadsApi.createLead(leadInput as any);
            const createdUUID = leadRes.data?.UUID;

            if (withJob && createdUUID) {
                // 2. Create job in Zenbooker
                const territoryId = territoryResult?.service_territory?.id;
                if (!territoryId) throw new Error('No territory for job creation');

                const jobPayload: Record<string, unknown> = {
                    territory_id: territoryId,
                    customer: {
                        name: [firstName, lastName].filter(Boolean).join(' ') || 'Unknown',
                        ...(phone && { phone }),
                        ...(email && { email }),
                    },
                    address: {
                        line1: streetAddress || 'N/A',
                        city: city || 'N/A',
                        ...(state && { state }),
                        ...(postalCode && { postal_code: postalCode }),
                        country: 'US',
                    },
                    services: [{
                        custom_service: {
                            name: jobType || 'General Service',
                            description: description || '',
                            price: Number(price) || 95,
                            duration: Number(duration) || 120,
                            taxable: false,
                        },
                    }],
                    assignment_method: 'auto',
                    sms_notifications: true,
                    email_notifications: true,
                };

                // Add timeslot if selected
                if (selectedTimeslot) {
                    jobPayload.timeslot_id = selectedTimeslot.id;
                } else {
                    // Fallback: tomorrow 8am-12pm
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    tomorrow.setHours(8, 0, 0, 0);
                    const end = new Date(tomorrow.getTime() + 4 * 60 * 60 * 1000);
                    jobPayload.timeslot = {
                        type: 'arrival_window',
                        start: tomorrow.toISOString(),
                        end: end.toISOString(),
                    };
                }

                const zbResult = await zenbookerApi.createJob(jobPayload);

                // 3. Link zenbooker job to lead
                await leadsApi.convertLead(createdUUID, { zenbooker_job_id: zbResult.job_id });

                toast.success('Lead & Job created', {
                    description: `Job ID: ${zbResult.job_id}`,
                });
            } else {
                toast.success('Lead created', {
                    description: `Status: Submitted`,
                });
            }

            // Invalidate lead-by-phone cache → LeadCard re-renders with the new data
            queryClient.invalidateQueries({ queryKey: ['lead-by-phone', phone] });
            onLeadCreated?.();
        } catch (err) {
            toast.error('Failed to create', {
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setSubmitting(false);
        }
    };

    // ── Validation ──
    const canProceedStep1 = !!(postalCode.trim() && territoryResult?.in_service_area);
    const canProceedStep2 = !!(Number(duration) > 0);
    const canProceedStep3 = !!selectedTimeslot || timeslotSkipped;

    // ── Step indicator ──
    const renderStepIndicator = () => (
        <div className="wizard__steps">
            {([1, 2, 3, 4] as Step[]).map((s) => (
                <div key={s} className="wizard__step-item">
                    <div
                        className={`wizard__step-circle ${s === step ? 'wizard__step-circle--active'
                            : s < step ? 'wizard__step-circle--done'
                                : ''
                            }`}
                    >
                        {s < step ? '✓' : s}
                    </div>
                    {s < 4 && <div className={`wizard__step-line ${s < step ? 'wizard__step-line--done' : ''}`} />}
                </div>
            ))}
            <span className="wizard__step-label">{STEP_LABELS[step]}</span>
        </div>
    );

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1 — Zip Code
    // ══════════════════════════════════════════════════════════════════════════
    const renderStep1 = () => (
        <div className="wizard__body">
            <div className="wizard__section-title">
                <MapPin className="w-4" /> Service Territory Check
            </div>
            <p className="wizard__hint">Enter the customer's zip code to verify the area is serviced.</p>

            <div className="wizard__row wizard__row--align-end">
                <div className="wizard__field" style={{ marginBottom: 0 }}>
                    <Label htmlFor="wz-zip">Zip Code *</Label>
                    <Input
                        id="wz-zip"
                        value={postalCode}
                        onChange={(e) => setPostalCode(e.target.value)}
                        placeholder="e.g. 02101"
                        maxLength={10}
                        className="wizard__input--short"
                    />
                </div>

                <div className="wizard__territory-status">
                    {territoryLoading && (
                        <span className="text-sm text-muted-foreground animate-pulse">Checking…</span>
                    )}
                    {territoryResult?.in_service_area && (
                        <Badge variant="default" className="bg-green-600">
                            ✓ {territoryResult.service_territory?.name || 'In service area'}
                        </Badge>
                    )}
                    {territoryError && !territoryLoading && (
                        <Badge variant="destructive">✗ {territoryError}</Badge>
                    )}
                </div>
            </div>

            <div className="wizard__divider" />
            <div className="wizard__section-title">
                <User className="w-4" /> Customer Info
            </div>
            <p className="wizard__hint">Phone is pre-filled from the call. Name & email are optional.</p>

            <div className="wizard__row">
                <div className="wizard__field">
                    <Label htmlFor="wz-fname">First Name</Label>
                    <Input id="wz-fname" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="John" />
                </div>
                <div className="wizard__field">
                    <Label htmlFor="wz-lname">Last Name</Label>
                    <Input id="wz-lname" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
                </div>
            </div>
            <div className="wizard__row">
                <div className="wizard__field wizard__field--wide">
                    <Label htmlFor="wz-phone">Phone</Label>
                    <Input id="wz-phone" value={formatPhone(phone)} disabled className="wizard__input--disabled" />
                </div>
                <div className="wizard__field wizard__field--wide">
                    <Label htmlFor="wz-email">Email</Label>
                    <Input id="wz-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" />
                </div>
            </div>
        </div>
    );

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2 — Service
    // ══════════════════════════════════════════════════════════════════════════
    const renderStep2 = () => (
        <div className="wizard__body">
            <div className="wizard__section-title">
                <Briefcase className="w-4" /> Select Service
            </div>
            <p className="wizard__hint">Define the job type, description, duration, and price.</p>

            <div className="wizard__field">
                <Label htmlFor="wz-jobtype">Job Type</Label>
                <Input id="wz-jobtype" value={jobType} onChange={(e) => setJobType(e.target.value)} placeholder="e.g. Plumbing Repair" />
            </div>
            <div className="wizard__field">
                <Label htmlFor="wz-desc">Description</Label>
                <Textarea
                    id="wz-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Additional details about the service…"
                    rows={3}
                />
            </div>
            <div className="wizard__row">
                <div className="wizard__field">
                    <Label htmlFor="wz-duration">
                        <Clock className="w-3 inline mr-1" />Duration (min) *
                    </Label>
                    <Input id="wz-duration" type="number" min="15" step="15" value={duration} onChange={(e) => setDuration(e.target.value)} />
                </div>
                <div className="wizard__field">
                    <Label htmlFor="wz-price">
                        <DollarSign className="w-3 inline mr-1" />Price ($)
                    </Label>
                    <Input id="wz-price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
                </div>
            </div>
        </div>
    );

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3 — Timeslots
    // ══════════════════════════════════════════════════════════════════════════
    const renderStep3 = () => (
        <div className="wizard__body">
            <div className="wizard__section-title">
                <Calendar className="w-4" /> Find Available Timeslots
            </div>
            <p className="wizard__hint">Select a date and timeslot, or skip to create a lead only.</p>

            <div className="wizard__row wizard__row--align-end">
                <div className="wizard__field">
                    <Label htmlFor="wz-date">Starting Date</Label>
                    <Input
                        id="wz-date"
                        type="date"
                        value={selectedDate}
                        onChange={(e) => {
                            setSelectedDate(e.target.value);
                            setSelectedTimeslot(null);
                            setTimeslotSkipped(false);
                        }}
                        min={new Date().toISOString().split('T')[0]}
                    />
                </div>
                <Button size="sm" variant="outline" onClick={fetchTimeslots} disabled={timeslotsLoading}>
                    {timeslotsLoading ? 'Loading…' : 'Refresh'}
                </Button>
            </div>

            {timeslotsLoading && (
                <p className="text-sm text-muted-foreground animate-pulse mt-2">Fetching available times…</p>
            )}

            {timeslotsError && !timeslotsLoading && (
                <p className="text-sm text-destructive mt-2">{timeslotsError}</p>
            )}

            <div className="wizard__timeslots">
                {timeslotDays.map((day) => {
                    if (!day.timeslots?.length) return null;
                    return (
                        <div key={day.date} className="wizard__day">
                            <p className="wizard__day-label">
                                {new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', {
                                    weekday: 'short', month: 'short', day: 'numeric',
                                })}
                            </p>
                            <div className="wizard__slots-grid">
                                {day.timeslots.map((slot) => (
                                    <button
                                        key={slot.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedTimeslot(slot);
                                            setTimeslotSkipped(false);
                                        }}
                                        className={`wizard__slot ${selectedTimeslot?.id === slot.id ? 'wizard__slot--selected' : ''}`}
                                    >
                                        {slot.formatted}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="wizard__divider" />

            {/* Skip timeslot */}
            {!showSkipConfirm ? (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowSkipConfirm(true)}
                    className="wizard__skip-btn"
                >
                    <SkipForward className="w-4 mr-1" /> Skip — create lead without scheduling
                </Button>
            ) : (
                <div className="wizard__skip-confirm">
                    <AlertTriangle className="w-4 text-amber-500 shrink-0" />
                    <span className="text-sm">Are you sure you want to create a lead only, without scheduling?</span>
                    <div className="wizard__skip-confirm-btns">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowSkipConfirm(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => {
                                setTimeslotSkipped(true);
                                setSelectedTimeslot(null);
                                setShowSkipConfirm(false);
                                setStep(4);
                            }}
                        >
                            Yes, skip
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 4 — Review & Create (all fields editable)
    // ══════════════════════════════════════════════════════════════════════════
    const renderStep4 = () => (
        <div className="wizard__body">
            <div className="wizard__section-title">
                <CheckCircle2 className="w-4" /> Review & Create
            </div>
            <p className="wizard__hint">Review and edit all fields before creating.</p>

            {/* ── Customer ── */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title"><User className="w-3.5" /> Customer</h4>
                <div className="wizard__row">
                    <div className="wizard__field">
                        <Label htmlFor="wz4-fname">First Name</Label>
                        <Input id="wz4-fname" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="John" />
                    </div>
                    <div className="wizard__field">
                        <Label htmlFor="wz4-lname">Last Name</Label>
                        <Input id="wz4-lname" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
                    </div>
                </div>
                <div className="wizard__row">
                    <div className="wizard__field wizard__field--wide">
                        <Label htmlFor="wz4-phone">Phone</Label>
                        <Input id="wz4-phone" value={formatPhone(phone)} disabled className="wizard__input--disabled" />
                    </div>
                    <div className="wizard__field wizard__field--wide">
                        <Label htmlFor="wz4-email">Email</Label>
                        <Input id="wz4-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" />
                    </div>
                </div>
            </div>

            {/* ── Address ── */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title">
                    <MapPin className="w-3.5" /> Address
                    {territoryResult?.in_service_area && (
                        <Badge variant="default" className="bg-green-600 ml-auto text-[10px]">
                            ✓ {territoryResult.service_territory?.name}
                        </Badge>
                    )}
                </h4>
                <div className="wizard__field">
                    <Label htmlFor="wz4-street">Street Address</Label>
                    <Input id="wz4-street" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} placeholder="123 Main St" />
                </div>
                <div className="wizard__row">
                    <div className="wizard__field wizard__field--wide">
                        <Label htmlFor="wz4-city">City</Label>
                        <Input id="wz4-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Boston" />
                    </div>
                    <div className="wizard__field">
                        <Label htmlFor="wz4-state">State</Label>
                        <select
                            id="wz4-state"
                            value={state}
                            onChange={(e) => setState(e.target.value)}
                            className="wizard__select"
                        >
                            <option value="MA">MA</option>
                            <option value="RI">RI</option>
                            <option value="NH">NH</option>
                        </select>
                    </div>
                    <div className="wizard__field">
                        <Label htmlFor="wz4-zip">Postal Code</Label>
                        <Input id="wz4-zip" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
                    </div>
                </div>
            </div>

            {/* ── Service ── */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title"><Briefcase className="w-3.5" /> Service</h4>
                <div className="wizard__field">
                    <Label htmlFor="wz4-jobtype">Job Type</Label>
                    <Input id="wz4-jobtype" value={jobType} onChange={(e) => setJobType(e.target.value)} placeholder="e.g. Plumbing Repair" />
                </div>
                <div className="wizard__field">
                    <Label htmlFor="wz4-desc">Description</Label>
                    <Textarea id="wz4-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Service details…" />
                </div>
                <div className="wizard__row">
                    <div className="wizard__field">
                        <Label htmlFor="wz4-dur"><Clock className="w-3 inline mr-1" />Duration (min)</Label>
                        <Input id="wz4-dur" type="number" min="15" step="15" value={duration} onChange={(e) => setDuration(e.target.value)} />
                    </div>
                    <div className="wizard__field">
                        <Label htmlFor="wz4-price"><DollarSign className="w-3 inline mr-1" />Price ($)</Label>
                        <Input id="wz4-price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
                    </div>
                </div>
            </div>

            {/* ── Schedule (read-only summary) ── */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title"><Calendar className="w-3.5" /> Schedule</h4>
                {selectedTimeslot ? (
                    <p className="text-sm">
                        {selectedTimeslot.formatted} —{' '}
                        {new Date(selectedTimeslot.start).toLocaleDateString('en-US', {
                            weekday: 'short', month: 'short', day: 'numeric',
                        })}
                    </p>
                ) : (
                    <p className="text-sm text-amber-600">No timeslot selected (lead only)</p>
                )}
            </div>

            {/* ── Action buttons ── */}
            <div className="wizard__actions">
                <Button
                    variant="outline"
                    onClick={() => handleCreate(false)}
                    disabled={submitting}
                    className="wizard__action-btn"
                >
                    <FileText className="w-4 mr-1.5" />
                    {submitting ? 'Creating…' : 'Create Lead Only'}
                </Button>
                <Button
                    onClick={() => handleCreate(true)}
                    disabled={submitting || !selectedTimeslot || !streetAddress.trim() || !city.trim()}
                    className="wizard__action-btn wizard__action-btn--primary"
                    title={!streetAddress.trim() || !city.trim() ? 'Street address and city are required to create a job' : !selectedTimeslot ? 'Select a timeslot on Step 3 to create a job' : ''}
                >
                    <CheckCircle2 className="w-4 mr-1.5" />
                    {submitting ? 'Creating…' : 'Create Lead and Job'}
                </Button>
            </div>
        </div>
    );

    // ══════════════════════════════════════════════════════════════════════════
    // Main render
    // ══════════════════════════════════════════════════════════════════════════
    return (
        <div className="wizard">
            {/* Header */}
            <div className="wizard__header">
                <div className="wizard__header-content">
                    <div className="wizard__header-left">
                        <div className="wizard__avatar">
                            <User className="wizard__avatar-icon" />
                        </div>
                        <div>
                            <div className="wizard__title">New Lead / Job</div>
                            <div className="wizard__phone-row">
                                <Phone className="w-3.5" />
                                <span>{formatPhone(phone)}</span>
                            </div>
                        </div>
                    </div>
                    {callCount !== undefined && (
                        <div className="wizard__badge">
                            <div className="wizard__badge-number">{callCount}</div>
                            <div className="wizard__badge-label">Calls</div>
                        </div>
                    )}
                </div>
            </div>

            {/* Step indicator */}
            {renderStepIndicator()}

            {/* Step content */}
            {step === 1 && renderStep1()}
            {step === 2 && renderStep2()}
            {step === 3 && renderStep3()}
            {step === 4 && renderStep4()}

            {/* Navigation */}
            {step < 4 && (
                <div className="wizard__nav">
                    <div>
                        {step > 1 && (
                            <Button variant="outline" size="sm" onClick={() => setStep((step - 1) as Step)}>
                                <ChevronLeft className="w-4 mr-0.5" /> Back
                            </Button>
                        )}
                    </div>
                    <Button
                        size="sm"
                        onClick={() => setStep((step + 1) as Step)}
                        disabled={
                            (step === 1 && !canProceedStep1) ||
                            (step === 2 && !canProceedStep2) ||
                            (step === 3 && !canProceedStep3)
                        }
                    >
                        Next <ChevronRight className="w-4 ml-0.5" />
                    </Button>
                </div>
            )}
            {step === 4 && (
                <div className="wizard__nav">
                    <Button variant="outline" size="sm" onClick={() => setStep(3)}>
                        <ChevronLeft className="w-4 mr-0.5" /> Back
                    </Button>
                    <div />
                </div>
            )}
        </div>
    );
}

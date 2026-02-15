import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';
import * as zenbookerApi from '../../services/zenbookerApi';
import * as leadsApi from '../../services/leadsApi';
import type { ServiceAreaResult, Timeslot, TimeslotDay } from '../../services/zenbookerApi';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConvertToJobDialogProps {
    lead: Lead;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: (lead: Lead) => void;
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
    1: 'Customer & Address',
    2: 'Service',
    3: 'Timeslot',
    4: 'Review & Confirm',
};

const US_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
    'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
    'VA', 'WA', 'WV', 'WI', 'WY',
];

// ─── Component ────────────────────────────────────────────────────────────────

export function ConvertToJobDialog({ lead, open, onOpenChange, onSuccess }: ConvertToJobDialogProps) {
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);

    // Step 1 — customer & address
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [address, setAddress] = useState('');
    const [unit, setUnit] = useState('');
    const [city, setCity] = useState('');
    const [state, setState] = useState('');
    const [postalCode, setPostalCode] = useState('');

    // Territory check
    const [territoryResult, setTerritoryResult] = useState<ServiceAreaResult | null>(null);
    const [territoryLoading, setTerritoryLoading] = useState(false);
    const [territoryError, setTerritoryError] = useState('');

    // Step 2 — service
    const [serviceName, setServiceName] = useState('');
    const [serviceDescription, setServiceDescription] = useState('');
    const [servicePrice, setServicePrice] = useState('0');
    const [serviceDuration, setServiceDuration] = useState('120');

    // Step 3 — timeslot
    const [selectedDate, setSelectedDate] = useState('');
    const [timeslotDays, setTimeslotDays] = useState<TimeslotDay[]>([]);
    const [selectedTimeslot, setSelectedTimeslot] = useState<Timeslot | null>(null);
    const [timeslotsLoading, setTimeslotsLoading] = useState(false);
    const [timeslotsError, setTimeslotsError] = useState('');

    // Coordinates from service-area check
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

    // ── Pre-fill from lead on open ──
    useEffect(() => {
        if (open && lead) {
            setStep(1);
            setName([lead.FirstName, lead.LastName].filter(Boolean).join(' ') || '');
            setPhone(lead.Phone || '');
            setEmail(lead.Email || '');
            setAddress(lead.Address || '');
            setUnit(lead.Unit || '');
            setCity(lead.City || '');
            setState(lead.State || '');
            setPostalCode(lead.PostalCode || '');

            setServiceName(lead.JobType || 'General Service');
            setServiceDescription(lead.Description || lead.Comments || '');
            setServicePrice('0');
            setServiceDuration('120');

            setTerritoryResult(null);
            setTerritoryError('');
            setTimeslotDays([]);
            setSelectedTimeslot(null);
            setTimeslotsError('');
            setCoords(null);

            // Default date = today
            const today = new Date();
            setSelectedDate(today.toISOString().split('T')[0]);
        }
    }, [open, lead]);

    // ── Territory check ──
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
                setTerritoryError('Postal code is not in any service area');
            }
        } catch (err) {
            setTerritoryError(err instanceof Error ? err.message : 'Service area check failed');
            setTerritoryResult(null);
        } finally {
            setTerritoryLoading(false);
        }
    }, []);

    // Auto-check territory when postal code changes
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
                duration: Number(serviceDuration) || 120,
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
    }, [territoryResult, selectedDate, serviceDuration, coords]);

    // Fetch when entering step 3
    useEffect(() => {
        if (step === 3) {
            fetchTimeslots();
        }
    }, [step, fetchTimeslots]);

    // ── Submit booking ──
    const handleSubmit = async () => {
        const territoryId = territoryResult?.service_territory?.id;
        if (!territoryId || !selectedTimeslot) return;

        setSubmitting(true);
        try {
            // 1. Create job in Zenbooker
            const jobPayload = {
                territory_id: territoryId,
                timeslot_id: selectedTimeslot.id,
                customer: {
                    name: name || 'Unknown',
                    ...(phone && { phone }),
                    ...(email && { email }),
                },
                address: {
                    ...(address && { line1: address }),
                    ...(unit && { line2: unit }),
                    ...(city && { city }),
                    ...(state && { state }),
                    ...(postalCode && { postal_code: postalCode }),
                    country: 'US',
                },
                services: [
                    {
                        custom_service: {
                            name: serviceName || 'General Service',
                            description: serviceDescription || '',
                            price: Number(servicePrice) || 0,
                            duration: Number(serviceDuration) || 120,
                            taxable: false,
                        },
                    },
                ],
                assignment_method: 'auto',
                sms_notifications: true,
                email_notifications: true,
            };

            const zbResult = await zenbookerApi.createJob(jobPayload);

            // 2. Mark lead as converted with the Zenbooker job ID
            await leadsApi.convertLead(lead.UUID, { zenbooker_job_id: zbResult.job_id });

            toast.success('Job created in Zenbooker', {
                description: `Job ID: ${zbResult.job_id}`,
            });

            onSuccess({ ...lead, Status: 'Converted' });
            onOpenChange(false);
        } catch (err) {
            toast.error('Failed to create job', {
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setSubmitting(false);
        }
    };

    // ── Validation ──
    const canProceedStep1 = !!(postalCode.trim() && territoryResult?.in_service_area && name.trim());
    const canProceedStep2 = !!(serviceName.trim() && Number(serviceDuration) > 0);
    const canProceedStep3 = !!selectedTimeslot;

    // ── Render helpers ──
    const renderStepIndicator = () => (
        <div className="flex items-center gap-1 mb-4">
            {([1, 2, 3, 4] as Step[]).map((s) => (
                <div key={s} className="flex items-center gap-1">
                    <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${s === step
                            ? 'bg-primary text-primary-foreground'
                            : s < step
                                ? 'bg-primary/20 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
                    >
                        {s < step ? '✓' : s}
                    </div>
                    {s < 4 && <div className={`w-8 h-0.5 ${s < step ? 'bg-primary/40' : 'bg-muted'}`} />}
                </div>
            ))}
            <span className="ml-2 text-sm font-medium text-muted-foreground">{STEP_TITLES[step]}</span>
        </div>
    );

    const renderStep1 = () => (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <Label htmlFor="cj-name">Full Name *</Label>
                    <Input id="cj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="John Doe" />
                </div>
                <div>
                    <Label htmlFor="cj-phone">Phone</Label>
                    <Input id="cj-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1..." />
                </div>
            </div>
            <div>
                <Label htmlFor="cj-email">Email</Label>
                <Input id="cj-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" />
            </div>
            <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                    <Label htmlFor="cj-address">Address</Label>
                    <Input id="cj-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St" />
                </div>
                <div>
                    <Label htmlFor="cj-unit">Unit / Apt</Label>
                    <Input id="cj-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Apt 4B" />
                </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
                <div>
                    <Label htmlFor="cj-city">City</Label>
                    <Input id="cj-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Boston" />
                </div>
                <div>
                    <Label htmlFor="cj-state">State</Label>
                    <select
                        id="cj-state"
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                        <option value="">—</option>
                        {US_STATES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <Label htmlFor="cj-zip">Postal Code *</Label>
                    <Input id="cj-zip" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="02101" />
                </div>
            </div>

            {/* Territory status */}
            <div className="flex items-center gap-2 min-h-[28px]">
                {territoryLoading && <span className="text-sm text-muted-foreground animate-pulse">Checking service area…</span>}
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
    );

    const renderStep2 = () => (
        <div className="space-y-4">
            <div>
                <Label htmlFor="cj-svc-name">Service Name *</Label>
                <Input id="cj-svc-name" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Plumbing Repair" />
            </div>
            <div>
                <Label htmlFor="cj-svc-desc">Description</Label>
                <Textarea
                    id="cj-svc-desc"
                    value={serviceDescription}
                    onChange={(e) => setServiceDescription(e.target.value)}
                    placeholder="Job description or notes..."
                    rows={4}
                />
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <Label htmlFor="cj-svc-price">Price ($)</Label>
                    <Input id="cj-svc-price" type="number" min="0" step="0.01" value={servicePrice} onChange={(e) => setServicePrice(e.target.value)} />
                </div>
                <div>
                    <Label htmlFor="cj-svc-duration">Duration (min) *</Label>
                    <Input id="cj-svc-duration" type="number" min="15" step="15" value={serviceDuration} onChange={(e) => setServiceDuration(e.target.value)} />
                </div>
            </div>
        </div>
    );

    const renderStep3 = () => (
        <div className="space-y-4">
            <div>
                <Label htmlFor="cj-date">Starting Date</Label>
                <Input
                    id="cj-date"
                    type="date"
                    value={selectedDate}
                    onChange={(e) => {
                        setSelectedDate(e.target.value);
                        setSelectedTimeslot(null);
                    }}
                    min={new Date().toISOString().split('T')[0]}
                />
            </div>
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={fetchTimeslots} disabled={timeslotsLoading}>
                    {timeslotsLoading ? 'Loading…' : 'Refresh Timeslots'}
                </Button>
                {timeslotsLoading && <span className="text-sm text-muted-foreground animate-pulse">Fetching available times…</span>}
            </div>

            {timeslotsError && !timeslotsLoading && (
                <p className="text-sm text-destructive">{timeslotsError}</p>
            )}

            <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                {timeslotDays.map((day) => {
                    if (!day.timeslots?.length) return null;
                    return (
                        <div key={day.date}>
                            <p className="text-xs font-semibold text-muted-foreground mb-1.5">
                                {new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                            </p>
                            <div className="grid grid-cols-2 gap-1.5">
                                {day.timeslots.map((slot) => (
                                    <button
                                        key={slot.id}
                                        type="button"
                                        onClick={() => setSelectedTimeslot(slot)}
                                        className={`p-2 rounded-md border text-sm text-left transition-colors ${selectedTimeslot?.id === slot.id
                                            ? 'border-primary bg-primary/10 font-medium'
                                            : 'border-border hover:border-primary/50 hover:bg-muted/50'
                                            }`}
                                    >
                                        {slot.formatted}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    const renderStep4 = () => (
        <div className="space-y-3 text-sm">
            <h4 className="font-semibold">Customer</h4>
            <div className="bg-muted/50 rounded-md p-3 space-y-1">
                <p><span className="text-muted-foreground">Name:</span> {name || '—'}</p>
                <p><span className="text-muted-foreground">Phone:</span> {phone || '—'}</p>
                <p><span className="text-muted-foreground">Email:</span> {email || '—'}</p>
            </div>

            <h4 className="font-semibold">Address</h4>
            <div className="bg-muted/50 rounded-md p-3">
                <p>{[address, unit].filter(Boolean).join(', ') || '—'}</p>
                <p>{[city, state, postalCode].filter(Boolean).join(', ')}</p>
            </div>

            <h4 className="font-semibold">Service</h4>
            <div className="bg-muted/50 rounded-md p-3 space-y-1">
                <p><span className="text-muted-foreground">Name:</span> {serviceName}</p>
                {serviceDescription && <p className="text-xs text-muted-foreground line-clamp-2">{serviceDescription}</p>}
                <p><span className="text-muted-foreground">Duration:</span> {serviceDuration} min • <span className="text-muted-foreground">Price:</span> ${servicePrice}</p>
            </div>

            <h4 className="font-semibold">Timeslot</h4>
            <div className="bg-muted/50 rounded-md p-3">
                {selectedTimeslot ? (
                    <p>{selectedTimeslot.formatted} — {new Date(selectedTimeslot.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                ) : (
                    <p className="text-destructive">No timeslot selected</p>
                )}
            </div>

            <div className="flex items-center gap-2 pt-1">
                <Badge variant="default" className="bg-green-600">
                    ✓ {territoryResult?.service_territory?.name}
                </Badge>
            </div>
        </div>
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Convert to Job — {lead?.FirstName} {lead?.LastName}</DialogTitle>
                </DialogHeader>

                {renderStepIndicator()}

                {step === 1 && renderStep1()}
                {step === 2 && renderStep2()}
                {step === 3 && renderStep3()}
                {step === 4 && renderStep4()}

                <DialogFooter className="flex justify-between pt-4">
                    <div>
                        {step > 1 && (
                            <Button variant="outline" onClick={() => setStep((step - 1) as Step)} disabled={submitting}>
                                Back
                            </Button>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                            Cancel
                        </Button>
                        {step < 4 ? (
                            <Button
                                onClick={() => setStep((step + 1) as Step)}
                                disabled={
                                    (step === 1 && !canProceedStep1) ||
                                    (step === 2 && !canProceedStep2) ||
                                    (step === 3 && !canProceedStep3)
                                }
                            >
                                Next
                            </Button>
                        ) : (
                            <Button onClick={handleSubmit} disabled={submitting || !selectedTimeslot}>
                                {submitting ? 'Creating…' : 'Create Job'}
                            </Button>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

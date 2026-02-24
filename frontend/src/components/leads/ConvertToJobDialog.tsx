import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';
import * as leadsApi from '../../services/leadsApi';
import { authedFetch } from '../../services/apiClient';
import type { ServiceAreaResult, Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import * as zenbookerApi from '../../services/zenbookerApi';
import { AddressAutocomplete, type AddressFields, EMPTY_ADDRESS } from '../AddressAutocomplete';

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

interface CustomFieldDef {
    id: string;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    sort_order: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ConvertToJobDialog({ lead, open, onOpenChange, onSuccess }: ConvertToJobDialogProps) {
    const [step, setStep] = useState<Step>(1);
    const [submitting, setSubmitting] = useState(false);

    // Step 1 — customer & address
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [addressFields, setAddressFields] = useState<AddressFields>(EMPTY_ADDRESS);

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

    // Dynamic job types from settings
    const [jobTypes, setJobTypes] = useState<string[]>([]);
    // Custom field definitions for metadata display
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);

    // ── Fetch job types and custom fields on open ──
    useEffect(() => {
        if (!open) return;
        authedFetch('/api/settings/lead-form')
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    if (data.jobTypes?.length) {
                        setJobTypes(data.jobTypes.map((jt: { name: string }) => jt.name));
                    }
                    if (data.customFields) {
                        setCustomFields(data.customFields.filter((f: CustomFieldDef) => !f.is_system));
                    }
                }
            })
            .catch(() => { });
    }, [open]);

    // ── Pre-fill from lead on open ──
    useEffect(() => {
        if (open && lead) {
            setStep(1);
            setName([lead.FirstName, lead.LastName].filter(Boolean).join(' ') || '');
            setPhone(lead.Phone || '');
            setEmail(lead.Email || '');
            setAddressFields({
                street: lead.Address || '',
                apt: lead.Unit || '',
                city: lead.City || '',
                state: lead.State || '',
                zip: lead.PostalCode || '',
                lat: lead.Latitude != null ? Number(lead.Latitude) : null,
                lng: lead.Longitude != null ? Number(lead.Longitude) : null,
            });

            setServiceName(lead.JobType || 'General Service');
            setServiceDescription(lead.Description || lead.Comments || '');
            setServicePrice('0');
            setServiceDuration('120');

            setTerritoryResult(null);
            setTerritoryError('');
            setTimeslotDays([]);
            setSelectedTimeslot(null);
            setTimeslotsError('');
            // Initialize coords from lead if available (fallback for when Zenbooker service area check doesn't return coordinates)
            const leadLat = lead.Latitude != null ? Number(lead.Latitude) : null;
            const leadLng = lead.Longitude != null ? Number(lead.Longitude) : null;
            setCoords(leadLat && leadLng ? { lat: leadLat, lng: leadLng } : null);

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
            if (addressFields.zip.trim().length >= 4) {
                checkTerritory(addressFields.zip.trim());
            }
        }, 600);
        return () => clearTimeout(timer);
    }, [addressFields.zip, checkTerritory]);

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
            // Build the Zenbooker job payload
            const zbJobPayload = {
                territory_id: territoryId,
                timeslot_id: selectedTimeslot.id,
                customer: {
                    name: name || 'Unknown',
                    ...(phone && { phone }),
                    ...(email && { email }),
                },
                address: {
                    ...(addressFields.street && { line1: addressFields.street }),
                    ...(addressFields.apt && { line2: addressFields.apt }),
                    ...(addressFields.city && { city: addressFields.city }),
                    ...(addressFields.state && { state: addressFields.state }),
                    ...(addressFields.zip && { postal_code: addressFields.zip }),
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

            // Single backend call: creates local job + ZB job + marks lead converted
            const result = await leadsApi.convertLead(lead.UUID, {
                zb_job_payload: zbJobPayload,
                service: { name: serviceName, description: serviceDescription },
                customer: { name, phone, email },
                address: {
                    line1: addressFields.street, line2: addressFields.apt,
                    city: addressFields.city, state: addressFields.state, postal_code: addressFields.zip,
                },
            });

            const jobId = result.data?.job_id;
            const zbJobId = result.data?.zenbooker_job_id;

            toast.success('Job created', {
                description: zbJobId ? `Zenbooker Job: ${zbJobId}` : `Local Job #${jobId}`,
                duration: 10000,
                action: jobId ? {
                    label: 'Open Job',
                    onClick: () => window.location.href = `/jobs/${jobId}`,
                } : undefined,
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
    const canProceedStep1 = !!(addressFields.zip.trim() && territoryResult?.in_service_area && name.trim());
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

            {/* Address with Google Places autocomplete */}
            <AddressAutocomplete
                header={<Label className="text-sm font-medium">Address</Label>}
                idPrefix="cj"
                defaultUseDetails={true}
                value={addressFields}
                onChange={(addr) => {
                    setAddressFields(addr);
                    // Update coords from Places if available
                    if (addr.lat && addr.lng) {
                        setCoords({ lat: addr.lat, lng: addr.lng });
                    }
                }}
            />

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
                {jobTypes.length > 0 ? (
                    <Select value={serviceName} onValueChange={setServiceName}>
                        <SelectTrigger id="cj-svc-name">
                            <SelectValue placeholder="Select service type" />
                        </SelectTrigger>
                        <SelectContent>
                            {jobTypes.map(jt => (
                                <SelectItem key={jt} value={jt}>{jt}</SelectItem>
                            ))}
                            {serviceName && !jobTypes.includes(serviceName) && (
                                <SelectItem key={serviceName} value={serviceName}>{serviceName}</SelectItem>
                            )}
                        </SelectContent>
                    </Select>
                ) : (
                    <Input id="cj-svc-name" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Plumbing Repair" />
                )}
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
                <p>{[addressFields.street, addressFields.apt].filter(Boolean).join(', ') || '—'}</p>
                <p>{[addressFields.city, addressFields.state, addressFields.zip].filter(Boolean).join(', ')}</p>
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

            {/* Lead details passed to Job */}
            <h4 className="font-semibold">Lead Details</h4>
            <div className="bg-muted/50 rounded-md p-3 space-y-1">
                {lead.JobSource && (
                    <p><span className="text-muted-foreground">Job Source:</span> {lead.JobSource}</p>
                )}
                {lead.Comments && lead.Comments !== lead.Description && (
                    <p><span className="text-muted-foreground">Comments:</span> {lead.Comments}</p>
                )}
                {lead.Metadata && Object.keys(lead.Metadata).length > 0 && (
                    <>
                        {Object.entries(lead.Metadata).map(([key, value]) => {
                            if (!value) return null;
                            const fieldDef = customFields.find(f => f.api_name === key);
                            const label = fieldDef?.display_name || key;
                            return (
                                <p key={key}><span className="text-muted-foreground">{label}:</span> {value}</p>
                            );
                        })}
                    </>
                )}
                {!lead.JobSource && !lead.Comments && (!lead.Metadata || Object.keys(lead.Metadata).length === 0) && (
                    <p className="text-muted-foreground">No additional details</p>
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
            <DialogContent className="max-w-xl max-h-[85vh] flex flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Convert to Job — {lead?.FirstName} {lead?.LastName}</DialogTitle>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto pr-1">
                    {renderStepIndicator()}

                    {step === 1 && renderStep1()}
                    {step === 2 && renderStep2()}
                    {step === 3 && renderStep3()}
                    {step === 4 && renderStep4()}
                </div>

                <DialogFooter className="flex justify-between pt-4 border-t shrink-0">
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

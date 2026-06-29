import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { SelectItem } from '../ui/select';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { Calendar, Clock, RefreshCw, X } from 'lucide-react';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';
import type { Lead } from '../../types/lead';
import type { ServiceAreaResult, Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import type { CustomFieldDef, Step } from './useConvertToJob';
import { STEP_TITLES } from './useConvertToJob';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { useAuth } from '../../auth/AuthProvider';
import { useAuthz } from '../../hooks/useAuthz';
import { todayInTZ } from '../../utils/companyTime';

interface StepProps {
    name: string; setName: (v: string) => void;
    phone: string; setPhone: (v: string) => void;
    email: string; setEmail: (v: string) => void;
    addressFields: AddressFields; setAddressFields: (v: AddressFields) => void;
    coords: { lat: number; lng: number } | null;
    setCoords: (v: { lat: number; lng: number } | null) => void;
    territoryLoading: boolean; territoryResult: ServiceAreaResult | null; territoryError: string;
    zipExists: boolean | null; zipArea: string; zipSource: string;
    serviceName: string; setServiceName: (v: string) => void;
    serviceDescription: string; setServiceDescription: (v: string) => void;
    servicePrice: string; setServicePrice: (v: string) => void;
    serviceDuration: string; setServiceDuration: (v: string) => void;
    jobTypes: string[];
    selectedDate: string; setSelectedDate: (v: string) => void;
    timeslotDays: TimeslotDay[]; selectedTimeslot: Timeslot | null; setSelectedTimeslot: (v: Timeslot | null) => void;
    timeslotsLoading: boolean; timeslotsError: string; fetchTimeslots: () => void;
    lead: Lead; customFields: CustomFieldDef[];
    step: Step; setStep: (s: Step) => void;
}

export function StepIndicator({ step }: { step: Step }) {
    return (
        <div className="flex items-center gap-1 mb-4">
            {([1, 2, 3, 4] as Step[]).map(s => (
                <div key={s} className="flex items-center gap-1">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${s === step ? 'bg-primary text-primary-foreground' : s < step ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>{s < step ? '✓' : s}</div>
                    {s < 4 && <div className={`w-8 h-0.5 ${s < step ? 'bg-primary/40' : 'bg-muted'}`} />}
                </div>
            ))}
            <span className="ml-2 text-sm font-medium text-muted-foreground">{STEP_TITLES[step]}</span>
        </div>
    );
}

export function ConvertStep1({ name, setName, phone, setPhone, email, setEmail, addressFields, setAddressFields, setCoords, territoryLoading, territoryError, zipExists, zipArea }: StepProps) {
    return (
        <div className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <FloatingField id="cj-name" label="Full Name" value={name} onChange={e => setName(e.target.value)} />
                <FloatingField id="cj-phone" label="Phone" value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
            <FloatingField id="cj-email" label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            <AddressAutocomplete idPrefix="cj" defaultUseDetails={true} hideDetailsToggle value={addressFields} onChange={addr => { setAddressFields(addr); if (addr.lat && addr.lng) setCoords({ lat: addr.lat, lng: addr.lng }); }} />
            <div className="flex items-center gap-2 min-h-[28px]">
                {territoryLoading && <span className="text-sm text-muted-foreground animate-pulse">Checking service area…</span>}
                {zipExists && <Badge variant="default" className="bg-green-600">✓ {zipArea || 'In service area'}</Badge>}
                {territoryError && !territoryLoading && <Badge variant="destructive">✗ {territoryError}</Badge>}
            </div>
        </div>
    );
}

export function ConvertStep2({ serviceName, setServiceName, serviceDescription, setServiceDescription, servicePrice, setServicePrice, serviceDuration, setServiceDuration, jobTypes }: StepProps) {
    return (
        <div className="space-y-3.5">
            {jobTypes.length > 0 ? (
                <FloatingSelect id="cj-svc-name" label="Service" value={serviceName} onValueChange={setServiceName}>
                    {jobTypes.map(jt => <SelectItem key={jt} value={jt}>{jt}</SelectItem>)}
                    {serviceName && !jobTypes.includes(serviceName) && <SelectItem key={serviceName} value={serviceName}>{serviceName}</SelectItem>}
                </FloatingSelect>
            ) : (
                <FloatingField id="cj-svc-name" label="Service" value={serviceName} onChange={e => setServiceName(e.target.value)} />
            )}
            <FloatingField id="cj-svc-desc" label="Description" textarea rows={4} value={serviceDescription} onChange={e => setServiceDescription(e.target.value)} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <FloatingField id="cj-svc-price" label="Price ($)" inputMode="decimal" value={servicePrice} onChange={e => setServicePrice(e.target.value)} />
                <FloatingField id="cj-svc-duration" label="Duration (min)" inputMode="numeric" value={serviceDuration} onChange={e => setServiceDuration(e.target.value)} />
            </div>
        </div>
    );
}

export function ConvertStep3({ selectedDate, setSelectedDate, timeslotsLoading, timeslotsError, timeslotDays, selectedTimeslot, setSelectedTimeslot, fetchTimeslots, coords, addressFields, territoryResult, setStep }: StepProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const [showCustomTime, setShowCustomTime] = useState(false);
    const isCustomSlot = selectedTimeslot?.type === 'arrival_window';

    return (
        <div className="space-y-3.5">
            {/* Header row */}
            <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <Calendar className="w-4" /> Available times
                </span>
                <Button size="sm" variant="secondary" onClick={() => setShowCustomTime(true)} className="flex items-center gap-1">
                    <Clock className="w-3.5" /> Custom time
                </Button>
            </div>

            <p className="text-xs text-muted-foreground">Select a date and timeslot for this job.</p>

            {/* Custom slot display */}
            {isCustomSlot && (
                <div className="flex items-center gap-2 p-2.5 rounded-md border border-primary bg-primary/10">
                    <span className="text-sm font-medium flex-1">★ Custom: {selectedTimeslot!.formatted}</span>
                    <button type="button" onClick={() => setSelectedTimeslot(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4" /></button>
                </div>
            )}

            {/* Date row with icon refresh */}
            <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                    <Label htmlFor="cj-date" className="blanc-eyebrow">Starting date</Label>
                    <Input id="cj-date" type="date" value={selectedDate} onChange={e => { setSelectedDate(e.target.value); setSelectedTimeslot(null); }} min={todayInTZ(companyTz)} className="h-[50px] rounded-xl bg-transparent text-[15px]" />
                </div>
                <Button size="icon" variant="ghost" onClick={fetchTimeslots} disabled={timeslotsLoading} title="Refresh timeslots" className="shrink-0 mb-0.5">
                    <RefreshCw className={`w-4 ${timeslotsLoading ? 'animate-spin' : ''}`} />
                </Button>
            </div>

            {timeslotsLoading && <p className="text-sm text-muted-foreground animate-pulse">Fetching available times…</p>}
            {timeslotsError && !timeslotsLoading && <p className="text-sm text-destructive">{timeslotsError}</p>}

            {/* Timeslot grid */}
            <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                {timeslotDays.map(day => { if (!day.timeslots?.length) return null; return (<div key={day.date}><p className="text-xs font-semibold text-muted-foreground mb-1.5">{new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p><div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">{day.timeslots.map(slot => (<button key={slot.id} type="button" onClick={() => setSelectedTimeslot(slot)} className={`p-2 rounded-md border text-sm text-left transition-colors ${selectedTimeslot?.id === slot.id ? 'border-primary bg-primary/10 font-medium' : 'border-border hover:border-primary/50 hover:bg-muted/50'}`}>{slot.formatted}</button>))}</div></div>); })}
            </div>

            <CustomTimeModal
                open={showCustomTime}
                onClose={() => setShowCustomTime(false)}
                newJobCoords={coords}
                newJobAddress={[addressFields.street, addressFields.city, addressFields.state, addressFields.zip].filter(Boolean).join(', ')}
                territoryId={territoryResult?.service_territory?.id}
                onConfirm={(customSlot) => {
                    setSelectedTimeslot(customSlot);
                    setShowCustomTime(false);
                    setStep(4 as Step);
                }}
            />
        </div>
    );
}

export function ConvertStep4({ name, phone, email, addressFields, serviceName, serviceDescription, servicePrice, serviceDuration, selectedTimeslot, territoryResult, lead, customFields, zipArea }: StepProps) {
    const { hasPermission } = useAuthz();
    const canViewSource = hasPermission('lead_source.view');
    const cardStyle = { background: 'rgba(117, 106, 89, 0.04)' };
    return (
        <div className="space-y-3 text-sm">
            <h4 className="font-semibold">Customer</h4>
            <div className="rounded-2xl p-3.5 space-y-1" style={cardStyle}>{name && <p><span className="text-muted-foreground">Name:</span> {name}</p>}{phone && <p><span className="text-muted-foreground">Phone:</span> {phone}</p>}{email && <p><span className="text-muted-foreground">Email:</span> {email}</p>}</div>
            <h4 className="font-semibold">Address</h4>
            <div className="rounded-2xl p-3.5" style={cardStyle}>{[addressFields.street, addressFields.apt].filter(Boolean).join(', ') && <p>{[addressFields.street, addressFields.apt].filter(Boolean).join(', ')}</p>}{[addressFields.city, addressFields.state, addressFields.zip].filter(Boolean).join(', ') && <p>{[addressFields.city, addressFields.state, addressFields.zip].filter(Boolean).join(', ')}</p>}</div>
            <h4 className="font-semibold">Service</h4>
            <div className="rounded-2xl p-3.5 space-y-1" style={cardStyle}><p><span className="text-muted-foreground">Name:</span> {serviceName}</p>{serviceDescription && <p className="text-xs text-muted-foreground line-clamp-2">{serviceDescription}</p>}<p><span className="text-muted-foreground">Duration:</span> {serviceDuration} min • <span className="text-muted-foreground">Price:</span> ${servicePrice}</p></div>
            <h4 className="font-semibold">Timeslot</h4>
            <div className="rounded-2xl p-3.5" style={cardStyle}>{selectedTimeslot ? <p>{selectedTimeslot.formatted} — {new Date(selectedTimeslot.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p> : <p className="text-destructive">No timeslot selected</p>}</div>
            <h4 className="font-semibold">Lead Details</h4>
            <div className="rounded-2xl p-3.5 space-y-1" style={cardStyle}>
                {canViewSource && lead.JobSource && <p><span className="text-muted-foreground">Job Source:</span> {lead.JobSource}</p>}
                {lead.Comments && lead.Comments !== lead.Description && <p><span className="text-muted-foreground">Comments:</span> {lead.Comments}</p>}
                {lead.Metadata && Object.keys(lead.Metadata).length > 0 && <>{Object.entries(lead.Metadata).map(([key, value]) => { if (!value) return null; const fieldDef = customFields.find(f => f.api_name === key); return <p key={key}><span className="text-muted-foreground">{fieldDef?.display_name || key}:</span> {value}</p>; })}</>}
                {!(canViewSource && lead.JobSource) && !lead.Comments && (!lead.Metadata || Object.keys(lead.Metadata).length === 0) && <p className="text-muted-foreground">No additional details</p>}
            </div>
            <div className="flex items-center gap-2 pt-1"><Badge variant="default" className="bg-green-600">✓ {zipArea || territoryResult?.service_territory?.name}</Badge></div>
        </div>
    );
}

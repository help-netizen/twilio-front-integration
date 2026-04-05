import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Calendar, Clock, RefreshCw, X } from 'lucide-react';
import { AddressAutocomplete, type AddressFields } from '../AddressAutocomplete';
import type { Lead } from '../../types/lead';
import type { ServiceAreaResult, Timeslot, TimeslotDay } from '../../services/zenbookerApi';
import type { CustomFieldDef, Step } from './useConvertToJob';
import { STEP_TITLES } from './useConvertToJob';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { useAuth } from '../../auth/AuthProvider';
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

export function ConvertStep1({ name, setName, phone, setPhone, email, setEmail, addressFields, setAddressFields, setCoords, territoryLoading, territoryResult, territoryError, zipExists, zipArea, zipSource }: StepProps) {
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><Label htmlFor="cj-name">Full Name *</Label><Input id="cj-name" value={name} onChange={e => setName(e.target.value)} placeholder="John Doe" /></div><div><Label htmlFor="cj-phone">Phone</Label><Input id="cj-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1..." /></div></div>
            <div><Label htmlFor="cj-email">Email</Label><Input id="cj-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" /></div>
            <AddressAutocomplete header={<Label className="text-sm font-medium">Address</Label>} idPrefix="cj" defaultUseDetails={true} value={addressFields} onChange={addr => { setAddressFields(addr); if (addr.lat && addr.lng) setCoords({ lat: addr.lat, lng: addr.lng }); }} />
            <div className="flex items-center gap-2 min-h-[28px]">
                {territoryLoading && <span className="text-sm text-muted-foreground animate-pulse">Checking service area…</span>}
                {zipExists && <Badge variant="default" className="bg-green-600">✓ {zipArea || territoryResult?.service_territory?.name || 'In service area'}</Badge>}
                {territoryError && !territoryLoading && <Badge variant="destructive">✗ {territoryError}</Badge>}
                {zipSource && <span className="text-xs text-muted-foreground" style={{ opacity: 0.6 }}>via {zipSource === 'fast' ? '⚡ fast API' : zipSource === 'zenbooker' ? '🔄 zenbooker fallback' : '❌ none'}</span>}
            </div>
        </div>
    );
}

export function ConvertStep2({ serviceName, setServiceName, serviceDescription, setServiceDescription, servicePrice, setServicePrice, serviceDuration, setServiceDuration, jobTypes }: StepProps) {
    return (
        <div className="space-y-4">
            <div><Label htmlFor="cj-svc-name">Service Name *</Label>
                {jobTypes.length > 0 ? (<Select value={serviceName} onValueChange={setServiceName}><SelectTrigger id="cj-svc-name"><SelectValue placeholder="Select service type" /></SelectTrigger><SelectContent>{jobTypes.map(jt => <SelectItem key={jt} value={jt}>{jt}</SelectItem>)}{serviceName && !jobTypes.includes(serviceName) && <SelectItem key={serviceName} value={serviceName}>{serviceName}</SelectItem>}</SelectContent></Select>) : (<Input id="cj-svc-name" value={serviceName} onChange={e => setServiceName(e.target.value)} placeholder="Plumbing Repair" />)}
            </div>
            <div><Label htmlFor="cj-svc-desc">Description</Label><Textarea id="cj-svc-desc" value={serviceDescription} onChange={e => setServiceDescription(e.target.value)} placeholder="Job description or notes..." rows={4} /></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><Label htmlFor="cj-svc-price">Price ($)</Label><Input id="cj-svc-price" type="number" min="0" step="0.01" value={servicePrice} onChange={e => setServicePrice(e.target.value)} /></div><div><Label htmlFor="cj-svc-duration">Duration (min) *</Label><Input id="cj-svc-duration" type="number" min="15" step="15" value={serviceDuration} onChange={e => setServiceDuration(e.target.value)} /></div></div>
        </div>
    );
}

export function ConvertStep3({ selectedDate, setSelectedDate, timeslotsLoading, timeslotsError, timeslotDays, selectedTimeslot, setSelectedTimeslot, fetchTimeslots, coords, addressFields, territoryResult, setStep }: StepProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const [showCustomTime, setShowCustomTime] = useState(false);
    const isCustomSlot = selectedTimeslot?.type === 'arrival_window';

    return (
        <div className="space-y-4">
            {/* Header row */}
            <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                    <Calendar className="w-4" /> Available Timeslots
                </span>
                <Button size="sm" variant="outline" onClick={() => setShowCustomTime(true)} className="flex items-center gap-1">
                    <Clock className="w-3.5" /> Custom Time
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
                <div className="flex-1">
                    <Label htmlFor="cj-date">Starting Date</Label>
                    <Input id="cj-date" type="date" value={selectedDate} onChange={e => { setSelectedDate(e.target.value); setSelectedTimeslot(null); }} min={todayInTZ(companyTz)} />
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
    return (
        <div className="space-y-3 text-sm">
            <h4 className="font-semibold">Customer</h4>
            <div className="bg-muted/50 rounded-md p-3 space-y-1"><p><span className="text-muted-foreground">Name:</span> {name || '—'}</p><p><span className="text-muted-foreground">Phone:</span> {phone || '—'}</p><p><span className="text-muted-foreground">Email:</span> {email || '—'}</p></div>
            <h4 className="font-semibold">Address</h4>
            <div className="bg-muted/50 rounded-md p-3"><p>{[addressFields.street, addressFields.apt].filter(Boolean).join(', ') || '—'}</p><p>{[addressFields.city, addressFields.state, addressFields.zip].filter(Boolean).join(', ')}</p></div>
            <h4 className="font-semibold">Service</h4>
            <div className="bg-muted/50 rounded-md p-3 space-y-1"><p><span className="text-muted-foreground">Name:</span> {serviceName}</p>{serviceDescription && <p className="text-xs text-muted-foreground line-clamp-2">{serviceDescription}</p>}<p><span className="text-muted-foreground">Duration:</span> {serviceDuration} min • <span className="text-muted-foreground">Price:</span> ${servicePrice}</p></div>
            <h4 className="font-semibold">Timeslot</h4>
            <div className="bg-muted/50 rounded-md p-3">{selectedTimeslot ? <p>{selectedTimeslot.formatted} — {new Date(selectedTimeslot.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p> : <p className="text-destructive">No timeslot selected</p>}</div>
            <h4 className="font-semibold">Lead Details</h4>
            <div className="bg-muted/50 rounded-md p-3 space-y-1">
                {lead.JobSource && <p><span className="text-muted-foreground">Job Source:</span> {lead.JobSource}</p>}
                {lead.Comments && lead.Comments !== lead.Description && <p><span className="text-muted-foreground">Comments:</span> {lead.Comments}</p>}
                {lead.Metadata && Object.keys(lead.Metadata).length > 0 && <>{Object.entries(lead.Metadata).map(([key, value]) => { if (!value) return null; const fieldDef = customFields.find(f => f.api_name === key); return <p key={key}><span className="text-muted-foreground">{fieldDef?.display_name || key}:</span> {value}</p>; })}</>}
                {!lead.JobSource && !lead.Comments && (!lead.Metadata || Object.keys(lead.Metadata).length === 0) && <p className="text-muted-foreground">No additional details</p>}
            </div>
            <div className="flex items-center gap-2 pt-1"><Badge variant="default" className="bg-green-600">✓ {zipArea || territoryResult?.service_territory?.name}</Badge></div>
        </div>
    );
}

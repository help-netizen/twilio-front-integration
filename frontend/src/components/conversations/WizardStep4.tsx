import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { PhoneInput } from '../ui/PhoneInput';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { CheckCircle2, FileText } from 'lucide-react';
import type { WizardState } from './wizardTypes';

export function WizardStep4(s: WizardState) {
    return (
        <div className="wizard__body">
            {/* Customer */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title">Customer</h4>
                <div className="wizard__row">
                    <div className="wizard__field wizard__field--wide"><Label htmlFor="wz4-fname">First Name</Label><Input id="wz4-fname" value={s.firstName} onChange={(e) => s.setFirstName(e.target.value)} placeholder="John" /></div>
                    <div className="wizard__field wizard__field--wide"><Label htmlFor="wz4-lname">Last Name</Label><Input id="wz4-lname" value={s.lastName} onChange={(e) => s.setLastName(e.target.value)} placeholder="Doe" /></div>
                </div>
                <div className="wizard__row">
                    <div className="wizard__field wizard__field--wide"><Label htmlFor="wz4-phone">Phone</Label><PhoneInput id="wz4-phone" value={s.phoneNumber} onChange={s.setPhoneNumber} /></div>
                    <div className="wizard__field wizard__field--wide"><Label htmlFor="wz4-email">Email</Label><Input id="wz4-email" type="email" value={s.email} onChange={(e) => s.setEmail(e.target.value)} placeholder="email@example.com" /></div>
                </div>
            </div>

            {/* Address */}
            <div className="wizard__review-section">
                <AddressAutocomplete
                    header={<h4 className="wizard__review-title" style={{ margin: 0 }}>Address{s.zipExists && <Badge variant="default" className="bg-green-600 ml-2 text-[10px]">✓ {s.zipArea || s.territoryResult?.service_territory?.name}</Badge>}{s.zbLoading && <span className="ml-2 text-xs animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>loading territory…</span>}</h4>}
                    idPrefix="wz4"
                    value={{ street: s.streetAddress, apt: s.unit, city: s.city, state: s.state, zip: /^\d/.test(s.postalCode) ? s.postalCode : (s.matchedZip || '') }}
                    onChange={(addr) => {
                        s.setStreetAddress(addr.street); s.setUnit(addr.apt || ''); s.setCity(addr.city); s.setState(addr.state); s.setPostalCode(addr.zip);
                        if (addr.lat != null && addr.lng != null) s.setCoords({ lat: addr.lat, lng: addr.lng });
                    }}
                />
            </div>

            {/* Service */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title">Service</h4>
                <div className="wizard__field">
                    <Label htmlFor="wz4-jobtype">Job Type</Label>
                    <Select value={s.jobType} onValueChange={s.setJobType}><SelectTrigger id="wz4-jobtype"><SelectValue placeholder="Select job type" /></SelectTrigger><SelectContent>{s.jobTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select>
                </div>
                <div className="wizard__field"><Label htmlFor="wz4-desc">Description</Label><Textarea id="wz4-desc" value={s.description} onChange={(e) => s.setDescription(e.target.value)} rows={2} placeholder="Service details…" /></div>
                <div className="wizard__row">
                    <div className="wizard__field"><Label htmlFor="wz4-dur">Duration (min)</Label><Input id="wz4-dur" type="number" min="15" step="15" value={s.duration} onChange={(e) => s.setDuration(e.target.value)} /></div>
                    <div className="wizard__field"><Label htmlFor="wz4-price">Price ($)</Label><Input id="wz4-price" type="number" min="0" step="0.01" value={s.price} onChange={(e) => s.setPrice(e.target.value)} /></div>
                </div>
            </div>

            {/* Schedule summary */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title">Schedule</h4>
                {s.selectedTimeslot ? (
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{s.selectedTimeslot.formatted}</p>
                ) : (
                    <p className="text-sm" style={{ color: 'var(--blanc-warning, #d97706)' }}>No timeslot selected (lead only)</p>
                )}
            </div>

            {/* Actions */}
            <div className="wizard__actions">
                <Button variant="outline" onClick={() => s.handleCreate(false)} disabled={s.submitting} className="wizard__action-btn">
                    <FileText className="w-4 mr-1.5" />{s.submitting ? 'Creating…' : 'Create Lead Only'}
                </Button>
                <Button onClick={() => s.handleCreate(true)} disabled={s.submitting || s.zbLoading || !s.selectedTimeslot || !s.streetAddress.trim() || !s.city.trim()} className="wizard__action-btn wizard__action-btn--primary"
                    title={s.zbLoading ? 'Waiting for Zenbooker territory data…' : !s.streetAddress.trim() || !s.city.trim() ? 'Street address and city are required to create a job' : !s.selectedTimeslot ? 'Select a timeslot on Step 3 to create a job' : ''}>
                    <CheckCircle2 className="w-4 mr-1.5" />{s.submitting ? 'Creating…' : s.zbLoading ? 'Waiting for territory…' : 'Create Lead & Job'}
                </Button>
            </div>
        </div>
    );
}

import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { SelectItem } from '../ui/select';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { PhoneInput } from '../ui/PhoneInput';
import { AddressAutocomplete } from '../AddressAutocomplete';
import { CheckCircle2, FileText } from 'lucide-react';
import type { WizardState } from './wizardTypes';

// Canon field skin for raw inputs that FloatingField can't host (number fields need min/step).
const numberFieldClass =
    'h-[50px] w-full rounded-xl border-[1.5px] border-input bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-ring disabled:cursor-not-allowed disabled:opacity-50';

export function WizardStep4(s: WizardState) {
    return (
        <div className="wizard__body">
            {/* Customer */}
            <div className="wizard__review-section">
                <h4 className="wizard__review-title">Customer</h4>
                <div className="space-y-3.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        <FloatingField id="wz4-fname" label="First Name" value={s.firstName} onChange={(e) => s.setFirstName(e.target.value)} />
                        <FloatingField id="wz4-lname" label="Last Name" value={s.lastName} onChange={(e) => s.setLastName(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        <PhoneInput id="wz4-phone" label="Phone" value={s.phoneNumber} onChange={s.setPhoneNumber} />
                        <FloatingField id="wz4-email" label="Email" type="email" value={s.email} onChange={(e) => s.setEmail(e.target.value)} />
                    </div>
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
                <div className="space-y-3.5">
                    <FloatingSelect id="wz4-jobtype" label="Job Type" value={s.jobType} onValueChange={s.setJobType}>
                        {s.jobTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                    </FloatingSelect>
                    <FloatingField id="wz4-desc" label="Description" textarea rows={2} value={s.description} onChange={(e) => s.setDescription(e.target.value)} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        <FloatingLabel label="Duration (min)" htmlFor="wz4-dur" filled={!!s.duration}>
                            <input id="wz4-dur" type="number" min="15" step="15" className={numberFieldClass} value={s.duration} onChange={(e) => s.setDuration(e.target.value)} />
                        </FloatingLabel>
                        <FloatingLabel label="Price ($)" htmlFor="wz4-price" filled={!!s.price}>
                            <input id="wz4-price" type="number" min="0" step="0.01" className={numberFieldClass} value={s.price} onChange={(e) => s.setPrice(e.target.value)} />
                        </FloatingLabel>
                    </div>
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
                {/* A Zenbooker job needs a phone. Email-origin (no phone) → hide the with-job leg until a phone is entered. */}
                {s.canCreateJob && (
                    <Button onClick={() => s.handleCreate(true)} disabled={s.submitting || s.zbLoading || !s.selectedTimeslot || !s.streetAddress.trim() || !s.city.trim()} className="wizard__action-btn wizard__action-btn--primary"
                        title={s.zbLoading ? 'Waiting for Zenbooker territory data…' : !s.streetAddress.trim() || !s.city.trim() ? 'Street address and city are required to create a job' : !s.selectedTimeslot ? 'Select a timeslot on Step 3 to create a job' : ''}>
                        <CheckCircle2 className="w-4 mr-1.5" />{s.submitting ? 'Creating…' : s.zbLoading ? 'Waiting for territory…' : 'Create Lead & Job'}
                    </Button>
                )}
            </div>
        </div>
    );
}

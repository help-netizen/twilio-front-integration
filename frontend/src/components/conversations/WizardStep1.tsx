import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { PhoneInput } from '../ui/PhoneInput';
import type { WizardState } from './wizardTypes';

export function WizardStep1(s: WizardState) {
    return (
        <div className="wizard__body">
            <div className="wizard__section-title">Territory Check</div>
            <div className="wizard__row wizard__row--align-end">
                <div className="wizard__field" style={{ marginBottom: 0 }}>
                    <Label htmlFor="wz-zip">Zip Code *</Label>
                    <Input id="wz-zip" value={s.postalCode} onChange={(e) => s.setPostalCode(e.target.value)} placeholder="e.g. 02101" maxLength={10} className="wizard__input--short" />
                </div>
                <div className="wizard__territory-status">
                    {s.territoryLoading && <span className="text-sm animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>Checking…</span>}
                    {s.zipExists && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 999, background: 'rgba(27, 139, 99, 0.1)', color: 'var(--blanc-success, #1b8b63)', fontSize: 13, fontWeight: 700 }}>
                            ✓ {s.zipArea || s.territoryResult?.service_territory?.name || 'In service area'}
                        </span>
                    )}
                    {s.territoryError && !s.territoryLoading && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 999, background: 'rgba(212, 77, 60, 0.1)', color: 'var(--blanc-danger, #d44d3c)', fontSize: 13, fontWeight: 700 }}>
                            ✗ {s.territoryError}
                        </span>
                    )}
                </div>
            </div>
            <div className="wizard__section-title" style={{ marginTop: 18 }}>Customer</div>
            <div className="wizard__row">
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-fname">First Name</Label><Input id="wz-fname" value={s.firstName} onChange={(e) => s.setFirstName(e.target.value)} placeholder="John" /></div>
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-lname">Last Name</Label><Input id="wz-lname" value={s.lastName} onChange={(e) => s.setLastName(e.target.value)} placeholder="Doe" /></div>
            </div>
            <div className="wizard__row">
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-phone">Phone</Label><PhoneInput id="wz-phone" value={s.phoneNumber} onChange={s.setPhoneNumber} /></div>
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-email">Email</Label><Input id="wz-email" type="email" value={s.email} onChange={(e) => s.setEmail(e.target.value)} placeholder="email@example.com" /></div>
            </div>
        </div>
    );
}

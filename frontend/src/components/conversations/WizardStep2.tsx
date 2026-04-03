import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { WizardState } from './wizardTypes';

export function WizardStep2(s: WizardState) {
    return (
        <div className="wizard__body">
            <div className="wizard__section-title">Service Details</div>
            <div className="wizard__field">
                <Label htmlFor="wz-jobtype">Job Type</Label>
                <Select value={s.jobType} onValueChange={s.setJobType}>
                    <SelectTrigger id="wz-jobtype"><SelectValue placeholder="Select job type" /></SelectTrigger>
                    <SelectContent>{s.jobTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
                </Select>
            </div>
            <div className="wizard__field">
                <Label htmlFor="wz-desc">Description</Label>
                <Textarea id="wz-desc" value={s.description} onChange={(e) => s.setDescription(e.target.value)} placeholder="Additional details about the service…" rows={2} />
            </div>
            <div className="wizard__row">
                <div className="wizard__field"><Label htmlFor="wz-duration">Duration (min) *</Label><Input id="wz-duration" type="number" min="15" step="15" value={s.duration} onChange={(e) => s.setDuration(e.target.value)} /></div>
                <div className="wizard__field"><Label htmlFor="wz-price">Price ($)</Label><Input id="wz-price" type="number" min="0" step="0.01" value={s.price} onChange={(e) => s.setPrice(e.target.value)} /></div>
            </div>
        </div>
    );
}

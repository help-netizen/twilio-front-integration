import { SelectItem } from '../ui/select';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import type { WizardState } from './wizardTypes';

// Canon field skin for raw inputs that FloatingField can't host (number fields need min/step).
const numberFieldClass =
    'h-[50px] w-full rounded-xl border-[1.5px] border-input bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-ring disabled:cursor-not-allowed disabled:opacity-50';

export function WizardStep2(s: WizardState) {
    return (
        <div className="wizard__body">
            <div className="wizard__section-title">Service Details</div>
            <div className="space-y-3.5">
                <FloatingSelect id="wz-jobtype" label="Job Type" value={s.jobType} onValueChange={s.setJobType}>
                    {s.jobTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                </FloatingSelect>
                <FloatingField id="wz-desc" label="Description" textarea rows={2} value={s.description} onChange={(e) => s.setDescription(e.target.value)} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <FloatingLabel label="Duration (min) *" htmlFor="wz-duration" filled={!!s.duration}>
                        <input id="wz-duration" type="number" min="15" step="15" className={numberFieldClass} value={s.duration} onChange={(e) => s.setDuration(e.target.value)} />
                    </FloatingLabel>
                    <FloatingLabel label="Price ($)" htmlFor="wz-price" filled={!!s.price}>
                        <input id="wz-price" type="number" min="0" step="0.01" className={numberFieldClass} value={s.price} onChange={(e) => s.setPrice(e.target.value)} />
                    </FloatingLabel>
                </div>
            </div>
        </div>
    );
}

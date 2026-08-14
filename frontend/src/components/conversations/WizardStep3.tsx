import { useState } from 'react';
import { Button } from '../ui/button';
import { FloatingLabel } from '../ui/floating-field';
import { Clock, SkipForward, AlertTriangle, X } from 'lucide-react';
import type { WizardState, Step } from './wizardTypes';
import { serverDate } from '../../utils/serverClock';
import { CustomTimeModal } from './CustomTimeModal';
import { slotRecommendationToSchedule } from '../leads/useConvertToJob';
import { formatCompanyTime } from '../../lib/companyTime';

// Canon field skin for raw inputs that FloatingField can't host (date input needs min).
const dateInputClass =
    'h-[50px] w-full rounded-xl border-[1.5px] border-input bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-ring disabled:cursor-not-allowed disabled:opacity-50';

// ZB-DECOUPLE C4b — the ZB timeslot grid is replaced by the native
// slot-recommendation engine (optional; Custom Time / Skip always available).
export function WizardStep3(s: WizardState) {
    const [showCustomTime, setShowCustomTime] = useState(false);
    const isCustom = s.selectedSchedule?.source === 'custom';

    return (
        <div className="wizard__body">
            <div className="wizard__section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Schedule</span>
                <Button size="sm" variant="outline" onClick={() => setShowCustomTime(true)} className="flex items-center gap-1" style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: 12 }}>
                    <Clock className="w-3.5" /> Custom Time
                </Button>
            </div>
            {isCustom && (
                <div className="flex items-center gap-2 p-2.5 rounded-md border border-primary bg-primary/10">
                    <span className="text-sm font-medium flex-1">★ Custom: {s.selectedSchedule.formatted}</span>
                    <button type="button" onClick={() => s.setSelectedSchedule(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4" /></button>
                </div>
            )}
            <div className="flex items-end gap-3.5">
                {/* Native date input always shows its format → label must always float (else it centers over mm/dd/yyyy). */}
                <FloatingLabel label="Starting Date" htmlFor="wz-date" filled className="flex-1">
                    <input id="wz-date" type="date" className={dateInputClass} value={s.selectedDate} onChange={(e) => { s.setSelectedDate(e.target.value); s.setTimeslotSkipped(false); }} min={serverDate().toISOString().split('T')[0]} />
                </FloatingLabel>
                <Button size="sm" variant="outline" onClick={s.fetchRecommendations} disabled={s.recsLoading} className="shrink-0">{s.recsLoading ? 'Loading…' : 'Refresh'}</Button>
            </div>
            {s.recsLoading && <p className="text-sm animate-pulse mt-2" style={{ color: 'var(--blanc-ink-3)' }}>Finding recommended slots…</p>}
            {s.engineEnabled === false && !s.recsLoading && (
                <p className="text-sm mt-2" style={{ color: 'var(--blanc-ink-3)' }}>Slot recommendations are not enabled — use Custom Time or skip.</p>
            )}
            {s.recsError && !s.recsLoading && s.engineEnabled !== false && <p className="text-sm mt-2" style={{ color: 'var(--blanc-danger, #d44d3c)' }}>{s.recsError}</p>}
            <div className="wizard__timeslots">
                {s.recommendations.map((rec: any) => {
                    const sched = slotRecommendationToSchedule(rec, s.companyTz);
                    const selected = s.selectedSchedule?.source === 'engine' && s.selectedSchedule.start === sched.start && s.selectedSchedule.techId === sched.techId;
                    const day = formatCompanyTime(rec.date, { weekday: 'short', month: 'short', day: 'numeric' }, s.companyTz);
                    return (
                        <button
                            key={`${rec.rank}-${rec.date}-${rec.time_frame.start}-${sched.techId ?? 'any'}`}
                            type="button"
                            onClick={() => { s.setSelectedSchedule(sched); s.setTimeslotSkipped(false); }}
                            className={`wizard__slot ${selected ? 'wizard__slot--selected' : ''}`}
                            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%' }}
                        >
                            <span>{day} · {rec.time_frame.start}–{rec.time_frame.end}</span>
                            <span style={{ color: 'var(--blanc-ink-3)', fontSize: 12 }}>{sched.techName || 'Any technician'}</span>
                        </button>
                    );
                })}
            </div>
            {!s.showSkipConfirm ? (
                <Button variant="ghost" size="sm" onClick={() => s.setShowSkipConfirm(true)} className="wizard__skip-btn"><SkipForward className="w-4 mr-1" /> Skip — create lead without scheduling</Button>
            ) : (
                <div className="wizard__skip-confirm">
                    <AlertTriangle className="w-4 text-amber-500 shrink-0" />
                    <span className="text-sm">Are you sure you want to create a lead only, without scheduling?</span>
                    <div className="wizard__skip-confirm-btns">
                        <Button size="sm" variant="outline" onClick={() => s.setShowSkipConfirm(false)}>Cancel</Button>
                        <Button size="sm" onClick={() => { s.setTimeslotSkipped(true); s.setSelectedSchedule(null); s.setShowSkipConfirm(false); s.setStep(4 as Step); }}>Yes, skip</Button>
                    </div>
                </div>
            )}

            <CustomTimeModal
                open={showCustomTime}
                onClose={() => setShowCustomTime(false)}
                newJobCoords={s.coords}
                newJobAddress={[s.streetAddress, s.city, s.state, s.postalCode].filter(Boolean).join(', ')}
                newJobDuration={Number(s.duration) || 120}
                onConfirm={(customSlot) => {
                    s.setSelectedSchedule({
                        start: customSlot.start,
                        end: customSlot.end,
                        formatted: customSlot.formatted,
                        techId: customSlot.techId ?? null,
                        source: 'custom',
                    });
                    s.setTimeslotSkipped(false);
                    setShowCustomTime(false);
                    s.setStep(4 as Step);
                }}
            />
        </div>
    );
}

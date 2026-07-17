import { useState } from 'react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Clock, SkipForward, AlertTriangle } from 'lucide-react';
import type { WizardState, Step } from './wizardTypes';
import { serverDate } from '../../utils/serverClock';
import { CustomTimeModal } from './CustomTimeModal';

export function WizardStep3(s: WizardState) {
    const [showCustomTime, setShowCustomTime] = useState(false);

    return (
        <div className="wizard__body">
            <div className="wizard__section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Timeslots</span>
                <Button size="sm" variant="outline" onClick={() => setShowCustomTime(true)} className="flex items-center gap-1" style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: 12 }}>
                    <Clock className="w-3.5" /> Custom Time
                </Button>
            </div>
            <div className="wizard__row wizard__row--align-end">
                <div className="wizard__field">
                    <Label htmlFor="wz-date">Starting Date</Label>
                    <Input id="wz-date" type="date" value={s.selectedDate} onChange={(e) => { s.setSelectedDate(e.target.value); s.setSelectedTimeslot(null); s.setTimeslotSkipped(false); }} min={serverDate().toISOString().split('T')[0]} />
                </div>
                <div className="wizard__field" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="outline" onClick={s.fetchTimeslots} disabled={s.timeslotsLoading}>{s.timeslotsLoading ? 'Loading…' : 'Refresh'}</Button>
                </div>
            </div>
            {s.timeslotsLoading && <p className="text-sm animate-pulse mt-2" style={{ color: 'var(--blanc-ink-3)' }}>Fetching available times…</p>}
            {s.timeslotsError && !s.timeslotsLoading && <p className="text-sm mt-2" style={{ color: 'var(--blanc-danger, #d44d3c)' }}>{s.timeslotsError}</p>}
            <div className="wizard__timeslots">
                {s.timeslotDays.map((day) => {
                    if (!day.timeslots?.length) return null;
                    return (
                        <div key={day.date} className="wizard__day">
                            <p className="wizard__day-label">{new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                            <div className="wizard__slots-grid">
                                {day.timeslots.map((slot: any) => (
                                    <button key={slot.id} type="button" onClick={() => { s.setSelectedTimeslot(slot); s.setTimeslotSkipped(false); }} className={`wizard__slot ${s.selectedTimeslot?.id === slot.id ? 'wizard__slot--selected' : ''}`}>{slot.formatted}</button>
                                ))}
                            </div>
                        </div>
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
                        <Button size="sm" onClick={() => { s.setTimeslotSkipped(true); s.setSelectedTimeslot(null); s.setShowSkipConfirm(false); s.setStep(4 as Step); }}>Yes, skip</Button>
                    </div>
                </div>
            )}

            <CustomTimeModal
                open={showCustomTime}
                onClose={() => setShowCustomTime(false)}
                newJobCoords={s.coords}
                newJobAddress={[s.streetAddress, s.city, s.state, s.postalCode].filter(Boolean).join(', ')}
                territoryId={s.territoryResult?.service_territory?.id}
                onConfirm={(customSlot) => {
                    s.setSelectedTimeslot(customSlot);
                    s.setTimeslotSkipped(false);
                    setShowCustomTime(false);
                    s.setStep(4 as Step);
                }}
            />
        </div>
    );
}

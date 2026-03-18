import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Clock } from 'lucide-react';

interface CustomTimeModalProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (customSlot: { type: 'arrival_window'; start: string; end: string; formatted: string }) => void;
}

/** Generate 2-hour arrival windows from 8 AM to 8 PM with 1-hour step */
function generateArrivalWindows(date: Date) {
    const windows: { label: string; start: Date; end: Date }[] = [];
    for (let h = 8; h <= 18; h++) {
        const start = new Date(date); start.setHours(h, 0, 0, 0);
        const end = new Date(date); end.setHours(h + 2, 0, 0, 0);
        const fmt = (d: Date) => {
            const hours = d.getHours();
            const ampm = hours >= 12 ? 'pm' : 'am';
            const h12 = hours % 12 || 12;
            return `${h12}${ampm}`;
        };
        windows.push({ label: `${fmt(start)}–${fmt(end)}`, start, end });
    }
    return windows;
}

function formatDateLabel(date: Date) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const target = new Date(date); target.setHours(0, 0, 0, 0);

    const dayLabel = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (target.getTime() === today.getTime()) return `${dayLabel} (Today)`;
    if (target.getTime() === tomorrow.getTime()) return `${dayLabel} (Tomorrow)`;
    return dayLabel;
}

export function CustomTimeModal({ open, onClose, onConfirm }: CustomTimeModalProps) {
    const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
    const [selectedWindow, setSelectedWindow] = useState<number | null>(null);

    const dateObj = useMemo(() => {
        const [y, m, d] = selectedDate.split('-').map(Number);
        return new Date(y, m - 1, d);
    }, [selectedDate]);

    const windows = useMemo(() => generateArrivalWindows(dateObj), [dateObj]);

    const handleConfirm = () => {
        if (selectedWindow === null) return;
        const w = windows[selectedWindow];
        const formatted = `${w.label} — ${formatDateLabel(dateObj)}`;
        onConfirm({
            type: 'arrival_window',
            start: w.start.toISOString(),
            end: w.end.toISOString(),
            formatted,
        });
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2"><Clock className="w-4" /> Custom Timeslot</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div>
                        <Label htmlFor="ctm-date">Date</Label>
                        <Input
                            id="ctm-date" type="date" value={selectedDate}
                            min={new Date().toISOString().split('T')[0]}
                            onChange={e => { setSelectedDate(e.target.value); setSelectedWindow(null); }}
                        />
                    </div>
                    <div>
                        <p className="text-sm text-muted-foreground mb-2">
                            Enter a custom time for <strong>{formatDateLabel(dateObj)}</strong>
                        </p>
                        <Label className="mb-1.5 block">Arrival window</Label>
                        <div className="grid grid-cols-3 gap-1.5 max-h-[240px] overflow-y-auto pr-1">
                            {windows.map((w, i) => (
                                <button
                                    key={i} type="button" onClick={() => setSelectedWindow(i)}
                                    className={`px-2 py-1.5 rounded-md border text-sm transition-colors ${selectedWindow === i
                                        ? 'border-primary bg-primary/10 font-medium text-primary'
                                        : 'border-border hover:border-primary/50 hover:bg-muted/50'
                                    }`}
                                >{w.label}</button>
                            ))}
                        </div>
                    </div>
                </div>
                <DialogFooter className="flex gap-2 pt-4">
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={handleConfirm} disabled={selectedWindow === null}>Confirm</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

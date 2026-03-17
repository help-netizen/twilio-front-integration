import { useState } from 'react';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Calendar } from './calendar';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';

// ─── Props ────────────────────────────────────────────────────────────────────

interface DateRangePickerPopoverProps {
    dateFrom?: string;          // yyyy-MM-dd
    dateTo?: string;            // yyyy-MM-dd
    onDateFromChange: (d: string) => void;
    onDateToChange: (d: string) => void;
    align?: 'start' | 'center' | 'end';
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DateRangePickerPopover({
    dateFrom,
    dateTo,
    onDateFromChange,
    onDateToChange,
    align = 'start',
}: DateRangePickerPopoverProps) {
    const [open, setOpen] = useState(false);

    const applyPreset = (from: Date, to: Date) => {
        onDateFromChange(format(from, 'yyyy-MM-dd'));
        onDateToChange(format(to, 'yyyy-MM-dd'));
        setOpen(false);
    };

    const label = (() => {
        if (dateFrom && dateTo) {
            return `${format(new Date(dateFrom + 'T00:00:00'), 'MMM dd')} – ${format(new Date(dateTo + 'T00:00:00'), 'MMM dd, yyyy')}`;
        }
        if (dateFrom) {
            return `From ${format(new Date(dateFrom + 'T00:00:00'), 'MMM dd, yyyy')}`;
        }
        return 'Date Range';
    })();

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2">
                    <CalendarIcon className="size-4" />
                    {label}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align={align}>
                <div className="flex">
                    <div className="border-r p-3 space-y-1">
                        <div className="text-sm font-medium mb-2">Presets</div>
                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                            const today = new Date();
                            applyPreset(today, today);
                        }}>Today</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                            const d = new Date(); d.setDate(d.getDate() - 7);
                            applyPreset(d, new Date());
                        }}>Last 7 days</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                            const d = new Date(); d.setDate(d.getDate() - 30);
                            applyPreset(d, new Date());
                        }}>Last 30 days</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                            const now = new Date();
                            applyPreset(new Date(now.getFullYear(), now.getMonth(), 1), now);
                        }}>This Month</Button>
                        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                            const now = new Date();
                            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                            const last = new Date(now.getFullYear(), now.getMonth(), 0);
                            applyPreset(prev, last);
                        }}>Last Month</Button>
                    </div>
                    <div className="p-3">
                        <div className="text-xs text-muted-foreground mb-1">From</div>
                        <Calendar
                            mode="single"
                            selected={dateFrom ? new Date(dateFrom + 'T00:00:00') : undefined}
                            onSelect={(date) => { if (date) onDateFromChange(format(date, 'yyyy-MM-dd')); }}
                        />
                        <div className="text-xs text-muted-foreground mb-1 mt-2">To</div>
                        <Calendar
                            mode="single"
                            selected={dateTo ? new Date(dateTo + 'T00:00:00') : undefined}
                            onSelect={(date) => { if (date) onDateToChange(format(date, 'yyyy-MM-dd')); }}
                        />
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

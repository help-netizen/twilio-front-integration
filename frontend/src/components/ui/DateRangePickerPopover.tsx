import { useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Calendar } from './calendar';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { BottomSheet } from './BottomSheet';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';

/**
 * ONE calendar, in range mode (owner, 2026-08-16).
 *
 * This used to render TWO calendars in `mode="single"`, labelled From and To,
 * stacked vertically — on a phone that is two full months of scrolling to say
 * "last week", and the second calendar never knew what the first had picked, so
 * nothing stopped you choosing a To before the From.
 *
 * react-day-picker (already a dependency, and the very library that was being
 * rendered twice) does ranges natively: first tap sets the start, second sets
 * the end, the days between highlight as you move, and it will not let the ends
 * cross. `ui/calendar.tsx` already carried range_start / range_middle /
 * range_end styling — the mode was simply never switched on. Desktop shows two
 * months side by side because it has the width; the phone shows one.
 */

interface DateRangePickerPopoverProps {
    dateFrom?: string;          // yyyy-MM-dd
    dateTo?: string;            // yyyy-MM-dd
    onDateFromChange: (d: string) => void;
    onDateToChange: (d: string) => void;
    align?: 'start' | 'center' | 'end';
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const parse = (value?: string) => (value ? new Date(value + 'T00:00:00') : undefined);

function startOfDay(offsetDays = 0): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d;
}

export function DateRangePickerPopover({
    dateFrom,
    dateTo,
    onDateFromChange,
    onDateToChange,
    align = 'start',
}: DateRangePickerPopoverProps) {
    const [open, setOpen] = useState(false);

    const selected: DateRange | undefined = dateFrom
        ? { from: parse(dateFrom), to: parse(dateTo) }
        : undefined;

    const applyRange = (from: Date, to: Date, close: boolean) => {
        onDateFromChange(iso(from));
        onDateToChange(iso(to));
        if (close) setOpen(false);
    };

    const handleSelect = (range: DateRange | undefined) => {
        if (!range?.from) return;
        // First tap: the start is chosen and the panel stays open for the end.
        // Second tap completes the range, so there is nothing left to ask.
        if (!range.to) {
            onDateFromChange(iso(range.from));
            onDateToChange(iso(range.from));
            return;
        }
        applyRange(range.from, range.to, true);
    };

    const label = (() => {
        if (dateFrom && dateTo) {
            const from = parse(dateFrom)!;
            const to = parse(dateTo)!;
            if (iso(from) === iso(to)) return format(from, 'MMM d, yyyy');
            return `${format(from, 'MMM d')} – ${format(to, 'MMM d, yyyy')}`;
        }
        if (dateFrom) return `From ${format(parse(dateFrom)!, 'MMM d, yyyy')}`;
        return 'Date Range';
    })();

    const PRESETS: { label: string; range: () => [Date, Date] }[] = [
        { label: 'Today', range: () => [startOfDay(), startOfDay()] },
        { label: 'Yesterday', range: () => [startOfDay(-1), startOfDay(-1)] },
        { label: 'Last 7 days', range: () => [startOfDay(-6), startOfDay()] },
        { label: 'Last 30 days', range: () => [startOfDay(-29), startOfDay()] },
        {
            label: 'This month',
            range: () => {
                const now = startOfDay();
                return [new Date(now.getFullYear(), now.getMonth(), 1), now];
            },
        },
        {
            label: 'Last month',
            range: () => {
                const now = startOfDay();
                return [
                    new Date(now.getFullYear(), now.getMonth() - 1, 1),
                    new Date(now.getFullYear(), now.getMonth(), 0),
                ];
            },
        },
    ];

    const presetButtons = PRESETS.map(preset => (
        <Button
            key={preset.label}
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => {
                const [from, to] = preset.range();
                applyRange(from, to, true);
            }}
        >
            {preset.label}
        </Button>
    ));

    const isMobile = isMobileViewport();

    if (isMobile) {
        return (
            <>
                <Button variant="outline" className="gap-2" onClick={() => setOpen(true)}>
                    <CalendarIcon className="size-4" />
                    {label}
                </Button>
                <BottomSheet open={open} onClose={() => setOpen(false)} title="Date range" size="full">
                    {/* Presets two-up: six of them in one column pushed the calendar
                        below the fold, which is the whole reason nobody scrolled to it. */}
                    <div className="mb-3 grid grid-cols-2 gap-1.5">{presetButtons}</div>
                    <div className="flex justify-center">
                        <Calendar
                            mode="range"
                            numberOfMonths={1}
                            defaultMonth={parse(dateFrom)}
                            selected={selected}
                            onSelect={handleSelect}
                        />
                    </div>
                </BottomSheet>
            </>
        );
    }

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
                    <div className="space-y-1 border-r p-3">
                        <div className="mb-2 text-sm font-medium">Presets</div>
                        {presetButtons}
                    </div>
                    <div className="p-3">
                        <Calendar
                            mode="range"
                            numberOfMonths={2}
                            defaultMonth={parse(dateFrom)}
                            selected={selected}
                            onSelect={handleSelect}
                        />
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

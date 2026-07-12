/**
 * TimeOffDialog — TECH-DAYOFF-001 management panel (FORM-CANON right-side layer).
 * Create a day-off period for one technician or the whole company (materialized
 * server-side into one row per active technician), plus a list of current &
 * upcoming periods with per-row delete (center-modal confirmation).
 * All input/display is in the company timezone; the API speaks UTC ISO.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
    Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter,
    DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import {
    fetchTimeOff, createTimeOff, deleteTimeOff,
    type TimeOffBlock, type CreateTimeOffPayload,
} from '../../services/scheduleApi';
import { dateInTZ, formatDateTimeInTZ } from '../../utils/companyTime';
import type { ProviderInfo } from '../../hooks/useScheduleData';

const COMPANY_VALUE = '__company__';
// The management list looks ahead one year — current & upcoming periods only
// (the server's overlap semantics keep an already-running period in view).
const LIST_HORIZON_MS = 365 * 24 * 3600 * 1000;
const NOTE_MAX = 500;

interface TimeOffDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** ZB team-member roster — the same list that drives the schedule lanes. */
    providers: ProviderInfo[];
    /** Company IANA timezone (dispatch settings). */
    timezone: string;
    /** Called after any successful create/delete so the parent refetches blocks. */
    onChanged: () => void;
}

/** Company-local date ("YYYY-MM-DD") + time ("HH:MM") → UTC ISO, or null. */
function toUtcIso(dateStr: string, timeStr: string, tz: string): string | null {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
    if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return dateInTZ(y, m, d, hh, mm, tz).toISOString();
}

function formatPeriod(block: TimeOffBlock, tz: string): string {
    return `${formatDateTimeInTZ(new Date(block.starts_at), tz)} – ${formatDateTimeInTZ(new Date(block.ends_at), tz)}`;
}

export const TimeOffDialog: React.FC<TimeOffDialogProps> = ({
    open, onOpenChange, providers, timezone, onChanged,
}) => {
    // ── Create form ──────────────────────────────────────────────────────────
    const [target, setTarget] = useState('');
    const [fromDate, setFromDate] = useState('');
    const [fromTime, setFromTime] = useState('00:00');
    const [toDate, setToDate] = useState('');
    const [toTime, setToTime] = useState('00:00');
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState('');

    // ── Current & upcoming list ──────────────────────────────────────────────
    const [blocks, setBlocks] = useState<TimeOffBlock[]>([]);
    const [deleteTarget, setDeleteTarget] = useState<TimeOffBlock | null>(null);
    const [deleting, setDeleting] = useState(false);

    const loadList = useCallback(async () => {
        try {
            const now = new Date();
            const list = await fetchTimeOff({
                from: now.toISOString(),
                to: new Date(now.getTime() + LIST_HORIZON_MS).toISOString(),
            });
            setBlocks([...list].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
        } catch (err: any) {
            toast.error(err.message || 'Failed to load time off');
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        setTarget('');
        setFromDate('');
        setFromTime('00:00');
        setToDate('');
        setToTime('00:00');
        setNote('');
        setFormError('');
        loadList();
    }, [open, loadList]);

    const handleSave = async () => {
        if (!target) { setFormError('Choose a technician or the whole company'); return; }
        const startsAt = toUtcIso(fromDate, fromTime, timezone);
        const endsAt = toUtcIso(toDate, toTime, timezone);
        if (!startsAt || !endsAt) { setFormError('Start and end dates are required'); return; }
        if (endsAt <= startsAt) { setFormError('End must be after start'); return; }
        setFormError('');

        const trimmedNote = note.trim();
        const payload: CreateTimeOffPayload = target === COMPANY_VALUE
            ? { target: 'company', starts_at: startsAt, ends_at: endsAt, ...(trimmedNote && { note: trimmedNote }) }
            : {
                target: 'technician',
                technician_id: target,
                technician_name: providers.find(p => p.id === target)?.name || '',
                starts_at: startsAt,
                ends_at: endsAt,
                ...(trimmedNote && { note: trimmedNote }),
            };

        setSaving(true);
        try {
            await createTimeOff(payload);
            toast.success('Time off added');
            setFromDate(''); setToDate(''); setNote('');
            await loadList();
            onChanged();
        } catch (err: any) {
            toast.error(err.message || 'Failed to add time off');
        } finally {
            setSaving(false);
        }
    };

    const handleConfirmDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            await deleteTimeOff(deleteTarget.id);
            setDeleteTarget(null);
            await loadList();
            onChanged();
        } catch (err: any) {
            toast.error(err.message || 'Failed to delete time off');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <DialogTitle
                            className="text-[22px] font-semibold leading-tight"
                            style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                        >
                            Time off
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                            Block out days when a technician or the whole company is off — no slots are offered during these periods
                        </DialogDescription>
                    </DialogPanelHeader>

                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px] space-y-6">
                            {/* Who is off */}
                            <div className="space-y-3.5">
                                <FloatingSelect label="Who" id="tod-target" value={target} onValueChange={setTarget}>
                                    <SelectItem value={COMPANY_VALUE}>Whole company</SelectItem>
                                    {providers.map(p => (
                                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                    ))}
                                </FloatingSelect>
                                {target === COMPANY_VALUE && (
                                    <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                                        While the whole company is off, no appointment slots will be offered to customers for this period.
                                    </p>
                                )}
                            </div>

                            {/* Period (company timezone) */}
                            <div className="space-y-3.5">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <FloatingField label="From date" id="tod-from-date" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                                    <FloatingField label="From time" id="tod-from-time" type="time" value={fromTime} onChange={e => setFromTime(e.target.value)} />
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                    <FloatingField label="To date" id="tod-to-date" type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
                                    <FloatingField label="To time" id="tod-to-time" type="time" value={toTime} onChange={e => setToTime(e.target.value)} />
                                </div>
                                <FloatingField
                                    label="Note"
                                    id="tod-note"
                                    textarea
                                    rows={2}
                                    value={note}
                                    onChange={e => setNote(e.target.value.slice(0, NOTE_MAX))}
                                />
                            </div>

                            {formError && (
                                <p className="text-sm text-red-600">{formError}</p>
                            )}

                            {/* Current & upcoming periods */}
                            {blocks.length > 0 && (
                                <div className="space-y-3.5">
                                    <span className="blanc-eyebrow">Scheduled time off</span>
                                    <div className="space-y-2">
                                        {blocks.map(b => (
                                            <div
                                                key={b.id}
                                                className="flex items-start gap-3 rounded-xl border px-4 py-3"
                                                style={{ borderColor: 'var(--blanc-line)' }}
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[15px] font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                                                        {b.technician_name}
                                                        {b.source === 'company' && (
                                                            <span className="ml-2 text-[12px] font-normal" style={{ color: 'var(--blanc-ink-3)' }}>
                                                                whole company
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>
                                                        {formatPeriod(b, timezone)}
                                                    </div>
                                                    {b.note && (
                                                        <div className="text-[13px] truncate" style={{ color: 'var(--blanc-ink-3)' }}>
                                                            {b.note}
                                                        </div>
                                                    )}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => setDeleteTarget(b)}
                                                    className="shrink-0 p-1 transition-opacity hover:opacity-70"
                                                    title="Delete time off"
                                                >
                                                    <Trash2 className="size-4" style={{ color: 'var(--blanc-ink-3)' }} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </DialogBody>

                    <DialogPanelFooter>
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={saving}>
                            {saving ? 'Saving...' : 'Save'}
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            {/* Delete confirmation — center modal (canon for short confirmations) */}
            <Dialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null); }}>
                <DialogContent variant="dialog" size="sm">
                    <DialogHeader>
                        <DialogTitle>Delete this time off?</DialogTitle>
                        <DialogDescription>
                            {deleteTarget && `${deleteTarget.technician_name} · ${formatPeriod(deleteTarget, timezone)}`}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                            Cancel
                        </Button>
                        <Button onClick={handleConfirmDelete} disabled={deleting}>
                            {deleting ? 'Deleting...' : 'Delete'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};

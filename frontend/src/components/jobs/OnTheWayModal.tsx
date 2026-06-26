/**
 * OnTheWayModal — ONWAY-001
 *
 * From a pre-visit job (Submitted / Rescheduled) a technician notifies the
 * customer that they're en route. On open the modal does ONE geolocation fix
 * (8s timeout). With a fix + a usable job address it shows a pre-selected
 * "Google ETA · ~N min" option; otherwise it falls back to preset tiles plus a
 * custom-minutes entry. "Notify client" sends the SMS and advances the job.
 *
 * State ladder (§2.1):
 *   (a) Requesting location — spinner + "Finding your location…" (tiles usable).
 *   (b) ETA computed        — highlighted, pre-selected Google option.
 *   (c) ETA unavailable     — muted note, no Google row (tiles + custom only).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Navigation, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import {
    Dialog, DialogContent, DialogPanelHeader, DialogTitle, DialogDescription, DialogBody, DialogPanelFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { estimateEta, notifyEta, EtaNotifyError, type LocalJob } from '../../services/jobsApi';

// ─── Constants ─────────────────────────────────────────────────────────────────

const PRESET_MINUTES = [10, 15, 20, 30, 45, 60] as const;
const GEO_TIMEOUT_MS = 8000;
const MIN_ETA = 1;
const MAX_ETA = 600;

// Active selection — exactly one of these at a time (§2.1).
type Selection =
    | { kind: 'google'; minutes: number }
    | { kind: 'tile'; minutes: number }
    | { kind: 'custom' }
    | null;

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
    open: boolean;
    onClose: () => void;
    job: LocalJob;
    onDone: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function OnTheWayModal({ open, onClose, job, onDone }: Props) {
    const [locating, setLocating] = useState(false);
    const [googleEta, setGoogleEta] = useState<number | null>(null); // state (b) when non-null
    const [etaUnavailable, setEtaUnavailable] = useState(false);     // state (c)
    const [selection, setSelection] = useState<Selection>(null);
    const [customValue, setCustomValue] = useState('');
    const [sending, setSending] = useState(false);

    // Guards against state updates after the modal closed / a stale geolocation
    // callback firing into a fresh open.
    const reqIdRef = useRef(0);

    // ── Reset + single geolocation fix on open ──
    useEffect(() => {
        if (!open) return;

        const reqId = ++reqIdRef.current;
        setGoogleEta(null);
        setEtaUnavailable(false);
        setSelection(null);
        setCustomValue('');
        setSending(false);

        if (typeof navigator === 'undefined' || !navigator.geolocation) {
            setLocating(false);
            setEtaUnavailable(true);
            return;
        }

        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                if (reqId !== reqIdRef.current) return; // superseded
                try {
                    const { eta_minutes } = await estimateEta(job.id, {
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                    });
                    if (reqId !== reqIdRef.current) return;
                    if (eta_minutes != null) {
                        setGoogleEta(eta_minutes);
                        setSelection({ kind: 'google', minutes: eta_minutes }); // pre-selected (state b)
                    } else {
                        setEtaUnavailable(true); // state (c)
                    }
                } catch {
                    if (reqId !== reqIdRef.current) return;
                    setEtaUnavailable(true);
                } finally {
                    if (reqId === reqIdRef.current) setLocating(false);
                }
            },
            () => {
                if (reqId !== reqIdRef.current) return;
                setLocating(false);
                setEtaUnavailable(true); // denied / unavailable / timeout → state (c)
            },
            { timeout: GEO_TIMEOUT_MS, enableHighAccuracy: false, maximumAge: 60000 },
        );
        // Closing+reopening re-requests once (reqId bump). Intentionally keyed on `open`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // ── Derived: the single chosen integer minutes (or null) ──
    const parsedCustom = Number(customValue);
    const customValid =
        customValue.trim() !== '' &&
        Number.isInteger(parsedCustom) &&
        parsedCustom >= MIN_ETA &&
        parsedCustom <= MAX_ETA;
    const customOutOfRange = customValue.trim() !== '' && !customValid;

    let chosenMinutes: number | null = null;
    if (selection?.kind === 'google' || selection?.kind === 'tile') chosenMinutes = selection.minutes;
    else if (selection?.kind === 'custom' && customValid) chosenMinutes = parsedCustom;

    // ── Handlers ──
    const pickGoogle = useCallback(() => {
        if (googleEta == null) return;
        setSelection({ kind: 'google', minutes: googleEta });
    }, [googleEta]);

    const pickTile = useCallback((minutes: number) => {
        setSelection({ kind: 'tile', minutes });
    }, []);

    const onCustomChange = useCallback((raw: string) => {
        // Digits only; selecting/typing a custom value deselects tile/Google.
        const cleaned = raw.replace(/[^0-9]/g, '');
        setCustomValue(cleaned);
        setSelection(cleaned.trim() === '' ? null : { kind: 'custom' });
    }, []);

    const handleNotify = useCallback(async () => {
        if (chosenMinutes == null || sending) return;
        setSending(true);
        try {
            const result = await notifyEta(job.id, chosenMinutes);
            if (result.warning) {
                toast.success("SMS sent, but the job status didn't update. You can change it manually.");
            } else {
                toast.success("Customer notified — you're marked On the way.");
            }
            onClose();
            onDone();
        } catch (err) {
            const code = err instanceof EtaNotifyError ? err.code : null;
            const message =
                code === 'NO_PHONE' ? 'No phone number on file for this customer.' :
                code === 'NO_PROXY' ? 'No sending number configured for your company.' :
                code === 'WALLET_BLOCKED' ? 'Messaging is paused — top up your balance.' :
                "Couldn't send the message. Please try again.";
            toast.error(message);
            setSending(false); // keep modal open so the user can retry
        }
    }, [chosenMinutes, sending, job.id, onClose, onDone]);

    // ── Render ──
    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v && !sending) onClose(); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        On the way
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Notify the customer that the technician is en route
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">

                    {/* State (a): requesting location */}
                    {locating && (
                        <div
                            className="inline-flex items-center gap-2 text-sm"
                            style={{ color: 'var(--blanc-ink-3)' }}
                        >
                            <Loader2 className="size-4 animate-spin" /> Finding your location…
                        </div>
                    )}

                    {/* State (b): Google ETA option — highlighted, pre-selected */}
                    {googleEta != null && (
                        <button
                            type="button"
                            onClick={pickGoogle}
                            className="w-full inline-flex items-center gap-2.5 px-4 text-left text-sm font-semibold transition-colors"
                            style={{
                                minHeight: 52,
                                borderRadius: 14,
                                border: `1.5px solid ${selection?.kind === 'google' ? '#0EA5E9' : 'var(--blanc-line)'}`,
                                background: selection?.kind === 'google' ? 'rgba(14,165,233,0.08)' : 'transparent',
                                color: 'var(--blanc-ink-1)',
                                cursor: 'pointer',
                            }}
                        >
                            <Navigation className="size-4" style={{ color: '#0EA5E9' }} />
                            Google ETA · ~{googleEta} min
                        </button>
                    )}

                    {/* State (c): ETA unavailable note (only when not locating, no Google) */}
                    {!locating && etaUnavailable && googleEta == null && (
                        <div className="space-y-1">
                            <div
                                className="inline-flex items-center gap-2 text-sm"
                                style={{ color: 'var(--blanc-ink-2)' }}
                            >
                                <MapPin className="size-4" style={{ color: 'var(--blanc-ink-3)' }} />
                                ETA unavailable — location is off.
                            </div>
                            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                Allow location access to get a live travel-time estimate, or pick a time below.
                            </p>
                        </div>
                    )}

                    {/* Preset tiles — always present */}
                    <div className="space-y-2.5">
                        <p className="blanc-eyebrow">Estimated arrival</p>
                        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
                            {PRESET_MINUTES.map((m) => {
                                const active = selection?.kind === 'tile' && selection.minutes === m;
                                return (
                                    <button
                                        key={m}
                                        type="button"
                                        onClick={() => pickTile(m)}
                                        className="inline-flex items-center justify-center text-sm font-semibold transition-colors"
                                        style={{
                                            minHeight: 46,
                                            borderRadius: 12,
                                            border: `1.5px solid ${active ? '#0EA5E9' : 'var(--blanc-line)'}`,
                                            background: active ? 'rgba(14,165,233,0.08)' : 'transparent',
                                            color: 'var(--blanc-ink-1)',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {m === 60 ? '1h' : `${m} min`}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Custom time */}
                    <div className="space-y-2">
                        <label
                            htmlFor="onway-custom-minutes"
                            className="text-sm font-medium"
                            style={{ color: 'var(--blanc-ink-2)' }}
                        >
                            Set custom time
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                id="onway-custom-minutes"
                                inputMode="numeric"
                                placeholder="e.g. 25"
                                value={customValue}
                                onFocus={() => { if (customValue.trim() !== '') setSelection({ kind: 'custom' }); }}
                                onChange={(e) => onCustomChange(e.target.value)}
                                aria-label="Minutes"
                                className="w-28 rounded-lg bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1"
                                style={{
                                    border: `1px solid ${selection?.kind === 'custom' && customValid ? '#0EA5E9' : 'var(--blanc-line)'}`,
                                    color: 'var(--blanc-ink-1)',
                                }}
                            />
                            <span className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>minutes</span>
                        </div>
                        {customOutOfRange && (
                            <p className="text-xs" style={{ color: 'var(--blanc-danger)' }}>
                                Enter 1–600 minutes.
                            </p>
                        )}
                    </div>

                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={onClose} disabled={sending}>
                        Cancel
                    </Button>
                    <Button onClick={handleNotify} disabled={sending || chosenMinutes == null}>
                        {sending ? 'Sending…' : 'Notify client'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

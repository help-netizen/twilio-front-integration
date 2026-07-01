import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
    slotEngineSettingsApi,
    SlotEngineSettingsError,
    SLOT_ENGINE_SETTINGS_DEFAULTS,
    SLOT_ENGINE_SETTINGS_RANGES,
    type SlotEngineSettings,
} from '../../services/slotEngineSettingsApi';

// ─── REC-SETTINGS-001 — "Recommendation settings" block ───────────────────────
// Per-company controls that feed the slot-recommendation engine. Self-contained:
// loads settings on mount, edits the 5 parameters, saves all 5 at once. Two further
// engine values (empty-day candidates, max day utilization) are fixed server-side
// and intentionally NOT shown here. Matches the CompanyBaseAddress form idiom.

const RANGES = SLOT_ENGINE_SETTINGS_RANGES;
const MINUTE_PRESETS = [0, 30, 60] as const;

/** Form state keeps raw strings so a transiently-empty input doesn't snap to a number. */
type FormState = Record<keyof SlotEngineSettings, string>;

function toForm(s: SlotEngineSettings): FormState {
    return {
        max_distance_miles: String(s.max_distance_miles),
        overlap_minutes: String(s.overlap_minutes),
        min_buffer_minutes: String(s.min_buffer_minutes),
        horizon_days: String(s.horizon_days),
        recommendations_shown: String(s.recommendations_shown),
    };
}

/** Parse a field to an integer, or null when blank / not a clean integer. */
function parseInt10(raw: string): number | null {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : null;
}

/** Client-side range hint for a field — null when the value is acceptable. */
function rangeError(key: keyof SlotEngineSettings, raw: string): string | null {
    const { min, max } = RANGES[key];
    const n = parseInt10(raw);
    if (n === null) return `Enter a whole number between ${min} and ${max}.`;
    if (n < min || n > max) return `Must be between ${min} and ${max}.`;
    return null;
}

const LABELS = { fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.14em', color: 'var(--blanc-ink-3)' };

export function RecommendationSettings() {
    const [form, setForm] = useState<FormState>(() => toForm(SLOT_ENGINE_SETTINGS_DEFAULTS));
    const [saved, setSaved] = useState<FormState>(() => toForm(SLOT_ENGINE_SETTINGS_DEFAULTS));
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let active = true;
        slotEngineSettingsApi.get()
            .then(s => { if (active) { setForm(toForm(s)); setSaved(toForm(s)); } })
            .catch(() => {
                // Load failed — keep the local DEFAULTS so the form stays usable.
                if (active) toast.error('Could not load recommendation settings — showing defaults.');
            })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    const set = (key: keyof SlotEngineSettings, value: string) => setForm(f => ({ ...f, [key]: value }));

    const dirty = useMemo(
        () => (Object.keys(form) as (keyof SlotEngineSettings)[]).some(k => form[k] !== saved[k]),
        [form, saved],
    );
    const errors = useMemo(() => {
        const e = {} as Record<keyof SlotEngineSettings, string | null>;
        (Object.keys(form) as (keyof SlotEngineSettings)[]).forEach(k => { e[k] = rangeError(k, form[k]); });
        return e;
    }, [form]);
    const hasError = (Object.keys(errors) as (keyof SlotEngineSettings)[]).some(k => errors[k] !== null);

    const onSave = async () => {
        // Build the payload from cleaned integers (errors already gate the button).
        const payload = {} as SlotEngineSettings;
        for (const key of Object.keys(form) as (keyof SlotEngineSettings)[]) {
            payload[key] = parseInt10(form[key]) as number;
        }
        setSaving(true);
        try {
            const result = await slotEngineSettingsApi.save(payload);
            setForm(toForm(result));
            setSaved(toForm(result));
            toast.success('Recommendation settings saved');
        } catch (e) {
            const msg = e instanceof SlotEngineSettingsError ? e.message : 'Failed to save recommendation settings';
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="rounded-2xl p-4" style={{ background: 'rgba(117, 106, 89, 0.04)' }}>
            <div className="blanc-eyebrow" style={LABELS}>Recommendation settings</div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>
                How the scheduler suggests arrival windows and providers.
            </p>

            <div className="mt-4 space-y-4">
                <NumberField
                    label="Max distance (mi)"
                    helper="Limits how far a provider can be from the nearest existing job — and from their base on an empty day — to be recommended."
                    value={form.max_distance_miles}
                    error={errors.max_distance_miles}
                    disabled={loading || saving}
                    onChange={v => set('max_distance_miles', v)}
                    range={RANGES.max_distance_miles}
                />

                <MinutePicker
                    label="Allow overlapping arrival windows"
                    helper="Minutes a new arrival window may overlap an existing one (0 = no overlap)."
                    value={form.overlap_minutes}
                    error={errors.overlap_minutes}
                    disabled={loading || saving}
                    onChange={v => set('overlap_minutes', v)}
                    range={RANGES.overlap_minutes}
                />

                <MinutePicker
                    label="Min buffer between jobs"
                    helper="Minimum slack required between consecutive jobs."
                    value={form.min_buffer_minutes}
                    error={errors.min_buffer_minutes}
                    disabled={loading || saving}
                    onChange={v => set('min_buffer_minutes', v)}
                    range={RANGES.min_buffer_minutes}
                />

                <NumberField
                    label="Planning horizon (days)"
                    helper="How many days ahead to look for open slots."
                    value={form.horizon_days}
                    error={errors.horizon_days}
                    disabled={loading || saving}
                    onChange={v => set('horizon_days', v)}
                    range={RANGES.horizon_days}
                />

                <NumberField
                    label="Recommendations shown"
                    helper="Maximum number of suggested slots returned."
                    value={form.recommendations_shown}
                    error={errors.recommendations_shown}
                    disabled={loading || saving}
                    onChange={v => set('recommendations_shown', v)}
                    range={RANGES.recommendations_shown}
                />
            </div>

            <div className="mt-4 flex items-center gap-3">
                <Button size="sm" disabled={loading || saving || !dirty || hasError} onClick={onSave}>
                    {saving ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" /> Saving…</span> : 'Save'}
                </Button>
                {loading && (
                    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                    </span>
                )}
            </div>
        </div>
    );
}

// ── Field primitives ──────────────────────────────────────────────────────────

const INPUT_STYLE: CSSProperties = {
    background: 'var(--blanc-panel-surface, #fffdf9)',
    borderColor: 'var(--blanc-line)',
    color: 'var(--blanc-ink-1)',
};

function FieldShell({ label, helper, error, children }: {
    label: string; helper: string; error: string | null; children: React.ReactNode;
}) {
    return (
        <div>
            <div className="blanc-eyebrow" style={LABELS}>{label}</div>
            {children}
            {error ? (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--blanc-danger, #b4533a)' }}>{error}</p>
            ) : (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--blanc-ink-3)' }}>{helper}</p>
            )}
        </div>
    );
}

function NumberField({ label, helper, value, error, disabled, onChange, range }: {
    label: string; helper: string; value: string; error: string | null; disabled: boolean;
    onChange: (v: string) => void; range: { min: number; max: number };
}) {
    return (
        <FieldShell label={label} helper={helper} error={error}>
            <input
                type="number"
                inputMode="numeric"
                min={range.min}
                max={range.max}
                step={1}
                value={value}
                disabled={disabled}
                onChange={e => onChange(e.target.value)}
                className="mt-1.5 w-28 rounded-lg border px-3 py-1.5 text-sm outline-none disabled:opacity-50"
                style={INPUT_STYLE}
            />
        </FieldShell>
    );
}

/** Segmented {0 / 30 / 60 / Custom} minute picker. Selecting Custom reveals a number input. */
function MinutePicker({ label, helper, value, error, disabled, onChange, range }: {
    label: string; helper: string; value: string; error: string | null; disabled: boolean;
    onChange: (v: string) => void; range: { min: number; max: number };
}) {
    const numeric = parseInt10(value);
    const isPreset = numeric !== null && (MINUTE_PRESETS as readonly number[]).includes(numeric);
    // A value not in {0,30,60} (or blank/invalid) sits in "Custom".
    const [custom, setCustom] = useState(!isPreset);
    const showCustomInput = custom || !isPreset;

    const seg = (active: boolean): CSSProperties => active
        ? { background: 'var(--blanc-panel-surface, #fffdf9)', color: 'var(--blanc-ink-1)' }
        : { color: 'var(--blanc-ink-3)' };

    return (
        <FieldShell label={label} helper={helper} error={error}>
            <div className="mt-1.5 inline-flex rounded-lg p-0.5" style={{ background: 'rgba(117, 106, 89, 0.08)' }}>
                {MINUTE_PRESETS.map(p => (
                    <button
                        key={p}
                        type="button"
                        disabled={disabled}
                        onClick={() => { setCustom(false); onChange(String(p)); }}
                        className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors disabled:opacity-50"
                        style={seg(!showCustomInput && numeric === p)}
                    >
                        {p}
                    </button>
                ))}
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setCustom(true)}
                    className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors disabled:opacity-50"
                    style={seg(showCustomInput)}
                >
                    Custom
                </button>
            </div>
            {showCustomInput && (
                <input
                    type="number"
                    inputMode="numeric"
                    min={range.min}
                    max={range.max}
                    step={1}
                    value={value}
                    disabled={disabled}
                    onChange={e => onChange(e.target.value)}
                    placeholder="Minutes"
                    className="mt-2 block w-28 rounded-lg border px-3 py-1.5 text-sm outline-none disabled:opacity-50"
                    style={INPUT_STYLE}
                />
            )}
        </FieldShell>
    );
}

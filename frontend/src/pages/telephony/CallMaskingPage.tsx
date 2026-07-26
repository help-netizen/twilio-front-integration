import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ShieldCheck, PhoneForwarded } from 'lucide-react';
import { telephonyApi, type MaskingSettings } from '../../services/telephonyApi';
import type { PhoneNumber } from '../../types/telephony';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { FloatingSelect } from '../../components/ui/floating-select';
import { SelectItem } from '../../components/ui/select';
import { Button } from '../../components/ui/button';

const ACCENT = 'var(--blanc-accent)';
const OK = 'var(--blanc-success)';
const INK1 = 'var(--blanc-ink-1)';
const INK2 = 'var(--blanc-ink-2)';
const INK3 = 'var(--blanc-ink-3)';

/** Render a masking number + example code the way a tech would dial it. */
function numberLabel(n: PhoneNumber): string {
    return n.friendly_name && n.friendly_name !== n.number ? `${n.number} · ${n.friendly_name}` : n.number;
}

export default function CallMaskingPage() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
    const [saved, setSaved] = useState<MaskingSettings | null>(null);
    const [selected, setSelected] = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const [settings, nums] = await Promise.all([
                    telephonyApi.getMaskingSettings(),
                    telephonyApi.listNumbers(),
                ]);
                if (!alive) return;
                setSaved(settings);
                setNumbers(nums);
                const owned = nums.some(n => n.number === settings.call_masking_number);
                setSelected(owned ? settings.call_masking_number : (nums[0]?.number || settings.call_masking_number));
            } catch (err) {
                if (alive) toast.error(err instanceof Error ? err.message : 'Failed to load call masking settings');
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, []);

    const enabled = !!saved?.call_masking_enabled;
    const numberChanged = !!saved && enabled && selected !== saved.call_masking_number;
    const activeNumber = enabled ? saved!.call_masking_number : selected;

    const save = async (payload: MaskingSettings, okMsg: string) => {
        setSaving(true);
        try {
            const next = await telephonyApi.saveMaskingSettings(payload);
            setSaved(next);
            setSelected(next.call_masking_number);
            toast.success(okMsg);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not save call masking settings');
        } finally {
            setSaving(false);
        }
    };

    const options = useMemo(
        () => numbers.map(n => <SelectItem key={n.id} value={n.number}>{numberLabel(n)}</SelectItem>),
        [numbers],
    );

    if (loading) {
        return (
            <SettingsPageShell eyebrow="Telephony" title="Call Masking">
                <div style={{ padding: 40, textAlign: 'center', color: INK3 }}>Loading…</div>
            </SettingsPageShell>
        );
    }

    const noNumbers = numbers.length === 0;

    // Footer action changes with state: Enable (off) · Save changes (on + number changed).
    const footer = noNumbers ? null : enabled ? (
        numberChanged ? (
            <Button onClick={() => save({ call_masking_enabled: true, call_masking_number: selected }, 'Masking number updated')} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
            </Button>
        ) : null
    ) : (
        <Button onClick={() => save({ call_masking_enabled: true, call_masking_number: selected }, 'Call masking enabled')} disabled={saving || !selected}>
            {saving ? 'Enabling…' : 'Enable'}
        </Button>
    );

    return (
        <SettingsPageShell
            eyebrow="Telephony"
            title="Call Masking"
            description="Let your team reach customers through a company number. The customer sees only your number — never the tech's personal line — and every call is recorded."
        >
            <SettingsSection
                title="Masking number"
                description="Choose which of your company numbers routes these calls."
                footer={footer}
            >
                {noNumbers ? (
                    <p className="text-sm" style={{ color: INK2 }}>
                        You don't have any phone numbers yet.{' '}
                        <Link to="/settings/telephony/phone-numbers" style={{ color: ACCENT, fontWeight: 600 }}>Add a number</Link>{' '}
                        first, then enable masking.
                    </p>
                ) : (
                    <div className="space-y-3.5">
                        {enabled && (
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <span style={{ width: 8, height: 8, borderRadius: 999, background: OK, display: 'inline-block' }} />
                                    <span className="text-sm font-medium" style={{ color: INK1 }}>Call masking is on</span>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => save({ call_masking_enabled: false, call_masking_number: selected }, 'Call masking turned off')}
                                    disabled={saving}
                                    style={{ color: INK2 }}
                                >
                                    Turn off
                                </Button>
                            </div>
                        )}
                        <FloatingSelect label="Masking number" value={selected} onValueChange={setSelected} disabled={saving}>
                            {options}
                        </FloatingSelect>
                    </div>
                )}
            </SettingsSection>

            {/* One self-contained, on-brand lavender badge — heading lives inside it. */}
            <section>
                <div style={{ background: 'var(--blanc-accent-soft)', borderRadius: 16, padding: '20px 22px' }}>
                    <div className="blanc-eyebrow" style={{ color: ACCENT }}>How it works</div>
                    <p className="text-[13px]" style={{ color: INK2, marginTop: 3, marginBottom: 16 }}>
                        Two ways your tech places a masked call.
                    </p>
                    <div className="space-y-4">
                        <div className="flex items-start gap-3">
                            <PhoneForwarded size={16} style={{ color: ACCENT, marginTop: 2, flexShrink: 0 }} />
                            <div>
                                <div className="text-sm font-semibold" style={{ color: INK1 }}>Direct dial</div>
                                <p className="text-[13px]" style={{ color: INK2, marginTop: 2, lineHeight: 1.5 }}>
                                    The tech dials <code style={codeStyle}>{activeNumber || 'your number'},,CODE</code> — the six-digit
                                    customer code shown on the job and contact.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <ShieldCheck size={16} style={{ color: ACCENT, marginTop: 2, flexShrink: 0 }} />
                            <div>
                                <div className="text-sm font-semibold" style={{ color: INK1 }}>IVR entry</div>
                                <p className="text-[13px]" style={{ color: INK2, marginTop: 2, lineHeight: 1.5 }}>
                                    Or the tech calls <code style={codeStyle}>{activeNumber || 'your number'}</code> from their
                                    registered phone and enters the code when prompted. The customer is called from your number and
                                    the call is recorded.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </SettingsPageShell>
    );
}

const codeStyle: React.CSSProperties = {
    fontFamily: 'monospace',
    fontSize: 12.5,
    padding: '1px 6px',
    borderRadius: 6,
    background: 'rgba(25,25,25,0.05)',
    color: 'var(--blanc-ink-1)',
};

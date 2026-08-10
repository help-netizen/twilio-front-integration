import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ShieldCheck, PhoneForwarded, AlertTriangle, ChevronRight } from 'lucide-react';
import { telephonyApi, type MaskingSettings } from '../../services/telephonyApi';
import type { PhoneNumber } from '../../types/telephony';
import { authedFetch } from '../../services/apiClient';
import type { CompanyUser, EditUserForm } from '../../hooks/useCompanyUsers';
import { EditUserDialog } from '../CompanyUserDialogs';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { FloatingSelect } from '../../components/ui/floating-select';
import { SelectItem } from '../../components/ui/select';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Switch } from '../../components/ui/switch';

/** Standard company roles, ordered field-first (the default masking audience). */
const ROLE_OPTIONS: Array<{ key: string; label: string }> = [
    { key: 'provider', label: 'Field Provider' },
    { key: 'dispatcher', label: 'Dispatcher' },
    { key: 'manager', label: 'Manager' },
    { key: 'tenant_admin', label: 'Admin' },
];

const ACCENT = 'var(--blanc-accent)';
const DANGER = 'var(--blanc-danger)';
const INK1 = 'var(--blanc-ink-1)';
const INK2 = 'var(--blanc-ink-2)';
const INK3 = 'var(--blanc-ink-3)';

/** Render a masking number + example code the way a tech would dial it. */
function numberLabel(n: PhoneNumber): string {
    return n.friendly_name && n.friendly_name !== n.number ? `${n.number} · ${n.friendly_name}` : n.number;
}

/** Normalize a row to one of the fixed role_keys the checkboxes use. */
function roleKeyOf(u: CompanyUser): string {
    if (u.role_key) return u.role_key;
    return u.legacy_role === 'company_admin' ? 'tenant_admin' : 'dispatcher';
}

const BLANK_EDIT: EditUserForm = {
    full_name: '', email: '', phone: '', role_key: 'dispatcher',
    phone_calls_allowed: false, is_provider: false, schedule_color: '#3B82F6',
    location_tracking_enabled: false,
};

export default function CallMaskingPage() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
    const [saved, setSaved] = useState<MaskingSettings | null>(null);
    const [selected, setSelected] = useState('');
    const [roles, setRoles] = useState<string[]>(['provider']);

    // #83 — members of the enabled roles with no phone on file, grouped by role_key.
    const [missingByRole, setMissingByRole] = useState<Record<string, CompanyUser[]>>({});

    // #83 — in-page profile editor (stays on this page; closing returns here).
    const [editUser, setEditUser] = useState<CompanyUser | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [editForm, setEditForm] = useState<EditUserForm>(BLANK_EDIT);
    const [savingUser, setSavingUser] = useState<string | null>(null);

    const loadMissing = useCallback(async (roleKeys: string[]) => {
        if (!roleKeys.length) { setMissingByRole({}); return; }
        try {
            const rows = await telephonyApi.getMaskingMissingPhone(roleKeys);
            const grouped: Record<string, CompanyUser[]> = {};
            for (const u of rows) (grouped[roleKeyOf(u)] ||= []).push(u);
            setMissingByRole(grouped);
        } catch {
            /* non-critical surface — leave the list empty on failure */
        }
    }, []);

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
                setRoles(settings.roles?.length ? settings.roles : ['provider']);
            } catch (err) {
                if (alive) toast.error(err instanceof Error ? err.message : 'Failed to load call masking settings');
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, []);

    // Refresh the missing-phone list whenever the selected roles change (and once
    // settings have loaded) — owner: show it "when the box is checked and on load".
    useEffect(() => {
        if (!loading) loadMissing(roles);
    }, [roles, loading, loadMissing]);

    const enabled = !!saved?.call_masking_enabled;
    const numberChanged = !!saved && enabled && selected !== saved.call_masking_number;
    const savedRoles = saved?.roles ?? [];
    const rolesChanged = !!saved && (roles.length !== savedRoles.length || roles.some(r => !savedRoles.includes(r)));
    const dirty = numberChanged || rolesChanged;
    const activeNumber = enabled ? saved!.call_masking_number : selected;

    const toggleRole = (key: string) =>
        setRoles(prev => (prev.includes(key) ? prev.filter(r => r !== key) : [...prev, key]));

    const save = async (payload: MaskingSettings, okMsg: string) => {
        setSaving(true);
        try {
            const next = await telephonyApi.saveMaskingSettings(payload);
            setSaved(next);
            setSelected(next.call_masking_number);
            setRoles(next.roles?.length ? next.roles : []);
            toast.success(okMsg);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not save call masking settings');
        } finally {
            setSaving(false);
        }
    };

    // ── In-page profile edit (#83) ────────────────────────────────────────────
    const openEdit = (u: CompanyUser) => {
        setEditUser(u);
        setEditForm({
            full_name: u.full_name || '',
            email: u.email || '',
            phone: u.phone || '',
            role_key: u.role_key || 'dispatcher',
            phone_calls_allowed: !!u.phone_calls_allowed,
            is_provider: !!u.is_provider,
            schedule_color: u.schedule_color || '#3B82F6',
            location_tracking_enabled: !!u.location_tracking_enabled,
        });
        setEditOpen(true);
    };

    const saveUser = async () => {
        if (!editUser) return;
        setSavingUser(editUser.id);
        try {
            const res = await authedFetch(`/api/users/${editUser.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name: editForm.full_name,
                    email: editForm.email,
                    role_key: editForm.role_key,
                    profile: {
                        phone: editForm.phone,
                        phone_calls_allowed: editForm.phone_calls_allowed,
                        is_provider: editForm.is_provider,
                        schedule_color: editForm.schedule_color,
                        location_tracking_enabled: editForm.location_tracking_enabled,
                    },
                }),
            });
            const json = await res.json().catch(() => ({}));
            if (res.ok) {
                toast.success('User updated');
                setEditOpen(false);
                loadMissing(roles); // whoever just got a phone drops off the list
                return;
            }
            toast.error(json.message || 'Failed to update user');
        } catch { toast.error('Connection error'); } finally { setSavingUser(null); }
    };

    const resetPasswordFor = async (u: CompanyUser) => {
        try {
            const res = await authedFetch(`/api/users/${u.id}/reset-password`, { method: 'POST' });
            if (res.ok) toast.success(`Password-reset link sent to ${u.email}`);
            else toast.error('Could not send the reset link');
        } catch { toast.error('Connection error'); }
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

    // Footer only carries the "save number/role changes" action now that on/off
    // lives in the top toggle (#81).
    const footer = noNumbers || !enabled || !dirty ? null : (
        <Button onClick={() => save({ call_masking_enabled: true, call_masking_number: selected, roles }, 'Call masking updated')} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
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
                    <div className="space-y-4">
                        {/* #81 — single top toggle replaces the Enable / Turn-off buttons. */}
                        <div className="flex items-center justify-between gap-3">
                            <div className="space-y-0.5">
                                <div className="text-sm font-medium" style={{ color: INK1 }}>Call masking</div>
                                <div className="text-[13px]" style={{ color: INK2 }}>
                                    {enabled
                                        ? 'On — the selected roles reach customers through your company number.'
                                        : 'Off — masked calling is disabled for everyone.'}
                                </div>
                            </div>
                            <Switch
                                checked={enabled}
                                disabled={saving || !selected}
                                onCheckedChange={v => save(
                                    { call_masking_enabled: v, call_masking_number: selected, roles },
                                    v ? 'Call masking enabled' : 'Call masking turned off',
                                )}
                            />
                        </div>

                        <FloatingSelect label="Masking number" value={selected} onValueChange={setSelected} disabled={saving}>
                            {options}
                        </FloatingSelect>

                        <div>
                            <div className="blanc-eyebrow" style={{ marginBottom: 8 }}>Who can place masked calls</div>
                            <div className="flex flex-col gap-2.5">
                                {ROLE_OPTIONS.map(r => {
                                    const missing = missingByRole[r.key] || [];
                                    const showMissing = roles.includes(r.key) && missing.length > 0;
                                    return (
                                        <div key={r.key}>
                                            <label className="flex cursor-pointer items-center gap-2.5">
                                                <Checkbox checked={roles.includes(r.key)} onCheckedChange={() => toggleRole(r.key)} disabled={saving} />
                                                <span className="text-sm" style={{ color: INK1 }}>{r.label}</span>
                                            </label>
                                            {/* #83 — under a checked role, the members who can't mask yet. */}
                                            {showMissing && (
                                                <div className="mt-1.5 space-y-1" style={{ marginLeft: 26 }}>
                                                    <div className="text-[12px]" style={{ color: DANGER }}>
                                                        No phone number on file — can't place masked calls until it's added:
                                                    </div>
                                                    {missing.map(u => (
                                                        <button
                                                            key={u.id}
                                                            type="button"
                                                            onClick={() => openEdit(u)}
                                                            className="flex items-center gap-1 text-left text-[13px]"
                                                            style={{ color: INK1 }}
                                                        >
                                                            <span className="underline decoration-dotted underline-offset-2">{u.full_name || u.email}</span>
                                                            <ChevronRight size={13} style={{ color: INK3 }} />
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <p className="text-[12px]" style={{ color: INK3, marginTop: 8, lineHeight: 1.5 }}>
                                These roles see the masked line and reach customers through your company number; the customer's real number is hidden from them.
                            </p>
                        </div>
                    </div>
                )}
            </SettingsSection>

            {/* One self-contained, on-brand lavender badge — heading lives inside it. */}
            <section>
                <div style={{ background: 'var(--blanc-accent-soft)', borderRadius: 16, padding: '20px 22px' }}>
                    <div className="blanc-eyebrow" style={{ color: ACCENT }}>How it works</div>

                    {/* #82 — the phone-number requirement, stated up front. */}
                    <div className="flex items-start gap-2" style={{ marginTop: 10, marginBottom: 16 }}>
                        <AlertTriangle size={16} style={{ color: ACCENT, marginTop: 2, flexShrink: 0 }} />
                        <p className="text-[13px]" style={{ color: INK1, lineHeight: 1.5 }}>
                            <strong>Each tech must have their mobile number saved in their profile.</strong>{' '}
                            Callers are recognized by that number — without it, the call falls back to your regular
                            company line instead of masking.
                        </p>
                    </div>

                    <p className="text-[13px] font-semibold" style={{ color: INK1, marginBottom: 12 }}>
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

            <EditUserDialog
                open={editOpen}
                setOpen={setEditOpen}
                user={editUser}
                form={editForm}
                setForm={setEditForm}
                handleUpdate={saveUser}
                loading={savingUser}
                onResetPassword={resetPasswordFor}
            />
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

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogBody, DialogPanelHeader, DialogPanelFooter } from '../components/ui/dialog';
import { FloatingField } from '../components/ui/floating-field';
import { Switch } from '../components/ui/switch';
import { Copy, KeyRound, Ban, Power, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState, type ReactNode } from 'react';
import type { CompanyUser, EditUserForm } from '../hooks/useCompanyUsers';
import { TechnicianServiceAreasEditor } from '../components/settings/TechnicianServiceAreas';
import { techniciansApi, type TechnicianServiceAreas } from '../services/techniciansApi';
import { technicianBaseLocationsApi } from '../services/technicianBaseLocationsApi';
import { PlaceAutocompleteInput } from '../components/PlaceAutocompleteInput';
import type { AddressFields } from '../components/addressAutoHelpers';


type CreateForm = { full_name: string; email: string; phone: string; role_key: string; phone_calls_allowed: boolean; is_provider: boolean; schedule_color: string; location_tracking_enabled: boolean };

/**
 * Sensible operational-setting defaults per role, applied when the role changes.
 * Softphone is for office roles (everyone except a pure Field Provider); the
 * Field-Provider flag + Location Tracking default on only for the Field Provider
 * role. These are just defaults — any of them can still be toggled by hand
 * afterwards (e.g. an admin who also runs jobs turns Field Provider on).
 */
export function roleOperationalDefaults(roleKey: string): Pick<CreateForm, 'phone_calls_allowed' | 'is_provider' | 'location_tracking_enabled'> {
    const provider = roleKey === 'provider';
    return {
        phone_calls_allowed: !provider,
        is_provider: provider,
        location_tracking_enabled: provider,
    };
}
// ─── Role cards (TEAM-FORM-002, Zenbooker-style) ─────────────────────────────
// One card per role; the selected card expands. Field-provider is NESTED inside
// each non-provider role («Also works in the field»); the Provider role is
// field work by definition. Permissions themselves live in Settings → Roles.

const ROLE_CARDS = [
    { key: 'provider', name: 'Provider', desc: 'Field technician. Sees only jobs assigned to them.' },
    { key: 'dispatcher', name: 'Dispatcher', desc: 'Runs the schedule: creates, assigns and reschedules jobs, talks to customers.' },
    { key: 'manager', name: 'Manager', desc: 'Full access to operations, finances and reports.' },
    { key: 'tenant_admin', name: 'Admin', desc: 'Everything — including team, roles, billing and integrations.' },
];

function RoleCards({ role, onRole, isProvider, onIsProvider, fieldContent }: {
    role: string;
    onRole: (key: string) => void;
    isProvider: boolean;
    onIsProvider: (v: boolean) => void;
    /** Territories / start location block, rendered inside the expanded card when field work is on. */
    fieldContent?: ReactNode;
}) {
    return (
        <div className="space-y-2.5">
            {ROLE_CARDS.map(r => {
                const sel = role === r.key;
                const fieldOn = r.key === 'provider' || isProvider;
                return (
                    <div
                        key={r.key}
                        className="rounded-2xl border overflow-hidden transition-colors"
                        style={{ borderColor: sel ? 'var(--blanc-accent)' : 'var(--blanc-line)' }}
                    >
                        <button
                            type="button"
                            className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
                            onClick={() => { onRole(r.key); if (r.key === 'provider') onIsProvider(true); }}
                        >
                            <span
                                className="mt-0.5 inline-block size-[18px] shrink-0 rounded-full transition-all"
                                style={sel
                                    ? { border: '6px solid var(--blanc-accent)' }
                                    : { border: '1.5px solid var(--blanc-line-strong)' }}
                            />
                            <span>
                                <span className="block text-[15px] font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>{r.name}</span>
                                <span className="mt-0.5 block text-[13px] leading-snug" style={{ color: 'var(--blanc-ink-2)' }}>{r.desc}</span>
                            </span>
                        </button>
                        {sel && (
                            <div className="space-y-4 px-4 pb-4 pt-3.5" style={{ background: 'var(--blanc-surface-muted)' }}>
                                {r.key === 'provider' ? (
                                    <p className="text-[12.5px] leading-snug" style={{ color: 'var(--blanc-ink-3)' }}>
                                        What providers can see and do is defined by the role — manage it in Settings → Roles &amp; permissions.
                                    </p>
                                ) : (
                                    <label className="flex cursor-pointer items-center justify-between gap-3">
                                        <span>
                                            <span className="block text-[14px] font-medium" style={{ color: 'var(--blanc-ink-1)' }}>Also works in the field</span>
                                            <span className="block text-[12.5px]" style={{ color: 'var(--blanc-ink-3)' }}>Can be assigned to jobs like a provider</span>
                                        </span>
                                        <Switch checked={isProvider} onCheckedChange={onIsProvider} />
                                    </label>
                                )}
                                {fieldOn && fieldContent}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ZB-DECOUPLE Phase E: no Zenbooker link. A provider / "also works in the field"
// user IS a native technician automatically — this section keys its territories
// and start location on the user's OWN native technician id (technicianId),
// which the backend derives. Null until the user is saved with the role/flag
// (the technician is created then); we show a "save first" hint in that window.
function FieldWorkSection({ technicianId, scheduleColor, onColorChange }: {
    technicianId: string | null;
    scheduleColor: string;
    onColorChange: (v: string) => void;
}) {
    const [areas, setAreas] = useState<TechnicianServiceAreas | null>(null);
    const [areasError, setAreasError] = useState(false);
    const [baseInput, setBaseInput] = useState('');
    const [baseSaved, setBaseSaved] = useState('');
    const [savingBase, setSavingBase] = useState(false);
    // Set only when the tech PICKS a Google suggestion — then we save its exact
    // coordinates instead of letting the server geocode the text (a typed string can
    // silently resolve to the wrong place, which throws off drive time and slots).
    // Any manual edit clears it, so free text / a bare ZIP still geocodes server-side.
    const [basePlace, setBasePlace] = useState<AddressFields | null>(null);

    useEffect(() => {
        setAreas(null); setAreasError(false); setBaseInput(''); setBaseSaved(''); setBasePlace(null);
        if (!technicianId) return;
        let cancelled = false;
        techniciansApi.getSettings(technicianId)
            .then(s => { if (!cancelled) setAreas(s.service_areas); })
            .catch(() => { if (!cancelled) setAreasError(true); });
        technicianBaseLocationsApi.list()
            .then(list => {
                if (cancelled) return;
                const mine = list.find(b => String(b.tech_id) === String(technicianId));
                const label = mine?.address || mine?.zip || '';
                setBaseInput(label); setBaseSaved(label);
            })
            .catch(() => { /* base stays editable from scratch */ });
        return () => { cancelled = true; };
    }, [technicianId]);

    const saveBase = async () => {
        if (!technicianId || !baseInput.trim()) return;
        setSavingBase(true);
        try {
            const saved = await technicianBaseLocationsApi.upsert(technicianId, {
                address: baseInput.trim(),
                // A picked place carries Google's own coordinates + parts — send them so
                // the backend stores exactly that spot. Without them it geocodes the text.
                ...(basePlace ? {
                    lat: basePlace.lat ?? null,
                    lng: basePlace.lng ?? null,
                    street: basePlace.street,
                    apt: basePlace.apt,
                    city: basePlace.city,
                    state: basePlace.state,
                    zip: basePlace.zip,
                } : {}),
            });
            const label = saved.address || baseInput.trim();
            setBaseInput(label); setBaseSaved(label);
            toast.success('Start location saved');
        } catch (e: any) {
            toast.error(e?.message || 'Could not save the start location');
        } finally {
            setSavingBase(false);
        }
    };

    return (
        <div className="space-y-4">
            {technicianId ? (
                <>
                    <div className="space-y-2">
                        <div className="blanc-eyebrow">Territories</div>
                        {areas ? (
                            <TechnicianServiceAreasEditor technicianId={technicianId} value={areas} onSaved={setAreas} />
                        ) : (
                            <p className="text-[12.5px]" style={{ color: 'var(--blanc-ink-3)' }}>
                                {areasError
                                    ? 'Couldn’t load territories — manage them in Settings → Scheduling & service areas.'
                                    : 'Loading territories…'}
                            </p>
                        )}
                    </div>
                    <div className="space-y-1.5">
                        <PlaceAutocompleteInput
                            id="tech-start-location"
                            label="Start location"
                            value={baseInput}
                            onChange={text => { setBaseInput(text); setBasePlace(null); }}
                            onPick={({ address, fields }) => { setBaseInput(address); setBasePlace(fields); }}
                        />
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-[12.5px] leading-snug" style={{ color: 'var(--blanc-ink-3)' }}>
                                Address or just a ZIP — drive time and slot suggestions count from here.
                            </p>
                            {baseInput.trim() !== '' && baseInput.trim() !== baseSaved.trim() && (
                                <Button type="button" variant="outline" size="sm" onClick={saveBase} disabled={savingBase}>
                                    {savingBase ? 'Saving…' : 'Save location'}
                                </Button>
                            )}
                        </div>
                    </div>
                </>
            ) : (
                <p className="text-[12.5px] leading-snug" style={{ color: 'var(--blanc-ink-3)' }}>
                    Save the user first — territories and the start location become editable here once they’re a field technician.
                </p>
            )}
            <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] font-medium" style={{ color: 'var(--blanc-ink-1)' }}>Schedule color</span>
                <div className="flex items-center gap-2.5">
                    <Input type="color" className="w-12 h-8 p-1 cursor-pointer bg-transparent" value={scheduleColor} onChange={e => onColorChange(e.target.value)} />
                    <span className="text-sm font-mono uppercase" style={{ color: 'var(--blanc-ink-3)' }}>{scheduleColor}</span>
                </div>
            </div>
        </div>
    );
}

interface CreateDialogProps { open: boolean; setOpen: (v: boolean) => void; createForm: CreateForm; setCreateForm: (fn: (f: CreateForm) => CreateForm) => void; creating: boolean; tempPassword: string | null; setTempPassword: (v: string | null) => void; handleCreate: () => void; }

export function CreateUserDialog({ open, setOpen, createForm, setCreateForm, creating, tempPassword, setTempPassword, handleCreate }: CreateDialogProps) {
    return (
        <Dialog open={open} onOpenChange={o => { if (!o) setTempPassword(null); setOpen(o); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        {tempPassword ? 'User created' : 'Add new user'}
                    </DialogTitle>
                    <DialogDescription className="sr-only">{tempPassword ? 'Share the temporary password with the user. It will only be shown once.' : 'The user will receive a temporary password and must change it on first login.'}</DialogDescription>
                </DialogPanelHeader>

                {tempPassword ? (
                    <>
                        <DialogBody className="md:px-8 md:py-7">
                            <div className="mx-auto w-full max-w-[740px] space-y-6">
                                <div className="rounded-xl p-4" style={{ background: 'rgba(25, 25, 25, 0.03)' }}>
                                    <div className="blanc-eyebrow">Temporary password</div>
                                    <div className="flex items-center gap-2 mt-1"><code className="text-lg font-mono font-semibold flex-1">{tempPassword}</code><Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(tempPassword); toast.success('Copied!'); }}><Copy className="size-4" /></Button></div>
                                    <p className="text-[12px] text-muted-foreground mt-2">Share the temporary password with the user. It will only be shown once.</p>
                                </div>
                            </div>
                        </DialogBody>
                        <DialogPanelFooter>
                            <Button onClick={() => { setOpen(false); setTempPassword(null); }}>Done</Button>
                        </DialogPanelFooter>
                    </>
                ) : (
                    <>
                        <DialogBody className="md:px-8 md:py-7">
                            <div className="mx-auto w-full max-w-[740px] space-y-6">
                                {/* Identity — one field per row (#84) */}
                                <div className="space-y-3.5">
                                    <FloatingField id="user-name" label="Full name" value={createForm.full_name} onChange={e => setCreateForm(f => ({ ...f, full_name: e.target.value }))} />
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                        <FloatingField id="user-email" label="Email" type="email" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} />
                                        <FloatingField id="user-phone" label="Mobile phone" value={createForm.phone} onChange={e => setCreateForm(f => ({ ...f, phone: e.target.value }))} />
                                    </div>
                                    <p className="text-[12.5px] leading-snug" style={{ color: 'var(--blanc-ink-3)' }}>
                                        The phone gets SMS about new jobs — and masked calls are recognized by it.
                                    </p>
                                </div>
                                <div className="space-y-3">
                                    <div className="blanc-eyebrow">Role</div>
                                    <RoleCards
                                        role={createForm.role_key}
                                        onRole={k => setCreateForm(f => ({ ...f, role_key: k, ...roleOperationalDefaults(k) }))}
                                        isProvider={createForm.is_provider}
                                        onIsProvider={v => setCreateForm(f => ({ ...f, is_provider: v }))}
                                        fieldContent={(
                                            <p className="text-[12.5px] leading-snug" style={{ color: 'var(--blanc-ink-3)' }}>
                                                Territories and the start location are set in the user's profile right after creating.
                                            </p>
                                        )}
                                    />
                                </div>
                            </div>
                        </DialogBody>
                        <DialogPanelFooter>
                            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                            <Button onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : 'Create user'}</Button>
                        </DialogPanelFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

interface EditUserDialogProps { 
    open: boolean; 
    setOpen: (v: boolean) => void;
    user: CompanyUser | null;
    form: EditUserForm; 
    setForm: (fn: (f: EditUserForm) => EditUserForm) => void; 
    handleUpdate: () => void;
    loading: string | null;
    onResetPassword?: (user: CompanyUser) => void;
    onToggleStatus?: (user: CompanyUser) => void;
    onDeleteUser?: (user: CompanyUser) => void;
}

export function EditUserDialog({ open, setOpen, user, form, setForm, handleUpdate, loading, onResetPassword, onToggleStatus, onDeleteUser }: EditUserDialogProps) {
    // The Provider role IS field work — keep the flag in sync so the PATCH
    // never unlinks the ZB bridge for a provider-role user.
    useEffect(() => {
        if (open && form.role_key === 'provider' && !form.is_provider) {
            setForm(f => ({ ...f, is_provider: true }));
        }
    }, [open, form.role_key, form.is_provider, setForm]);

    // In-app confirmation (never the browser's window.confirm) for destructive actions.
    const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({ open: false, title: '', description: '', onConfirm: () => { } });
    const closeConfirm = () => setConfirmDialog(p => ({ ...p, open: false }));

    if (!user) return null;

    const isActive = user.membership_status === 'active';
    const busy = loading === user.id;

    const handleDisableToggle = () => {
        if (!onToggleStatus) return;
        if (!isActive) { onToggleStatus(user); setOpen(false); return; } // enabling needs no confirmation
        setConfirmDialog({
            open: true,
            title: 'Disable user',
            description: `Disable ${user.full_name || user.email}? They will lose access to the company.`,
            onConfirm: () => { closeConfirm(); onToggleStatus(user); setOpen(false); },
        });
    };

    const handleDelete = () => {
        if (!onDeleteUser) return;
        setConfirmDialog({
            open: true,
            title: 'Remove from company',
            description: `Permanently remove ${user.full_name || user.email} from the company? This unlinks their account and cannot be undone.`,
            onConfirm: () => { closeConfirm(); onDeleteUser(user); },
        });
    };

    return (
        <>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Edit user profile
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Update role and operational settings for {user.full_name}.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    {/* OB-36: identity — full name, sign-in email, phone. Company-admin
                        surface only (the super-admin dialog omits onResetPassword). */}
                    {onResetPassword && (
                      <div className="space-y-3.5">
                        {/* Account actions pinned at the very top, before Identity. */}
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => onResetPassword(user)}>
                                <KeyRound className="size-4 mr-1.5" /> Send password-reset link
                            </Button>
                            {onToggleStatus && (
                                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handleDisableToggle}>
                                    {isActive
                                        ? <><Ban className="size-4 mr-1.5" /> Disable user</>
                                        : <><Power className="size-4 mr-1.5" /> Enable user</>}
                                </Button>
                            )}
                            {/* #86: fully unlink a disabled user (destructive) — same row. */}
                            {!isActive && onDeleteUser && (
                                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handleDelete} style={{ color: 'var(--blanc-danger)' }}>
                                    <Trash2 className="size-4 mr-1.5" /> Remove from company
                                </Button>
                            )}
                        </div>

                        <div className="blanc-eyebrow">Identity</div>
                        <FloatingField id="edit-user-name" label="Full name" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            <FloatingField id="edit-user-email" label="Email (sign-in)" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                            <FloatingField id="edit-user-phone" label="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                        </div>
                      </div>
                    )}

                    <div className="space-y-3">
                        <div className="blanc-eyebrow">Role</div>
                        <RoleCards
                            role={form.role_key}
                            onRole={k => setForm(f => ({ ...f, role_key: k, ...roleOperationalDefaults(k) }))}
                            isProvider={form.is_provider}
                            onIsProvider={v => setForm(f => ({ ...f, is_provider: v }))}
                            fieldContent={(
                                <FieldWorkSection
                                    technicianId={user?.technician_id ?? null}
                                    scheduleColor={form.schedule_color}
                                    onColorChange={v => setForm(f => ({ ...f, schedule_color: v }))}
                                />
                            )}
                        />
                    </div>

                    <div className="space-y-4">
                        <div className="blanc-eyebrow">Operational settings</div>

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <Label>Softphone Access</Label>
                                <div className="text-[13px] text-muted-foreground">Can make/receive calls via browser</div>
                            </div>
                            <Switch checked={form.phone_calls_allowed} onCheckedChange={v => setForm(f => ({ ...f, phone_calls_allowed: v }))} />
                        </div>

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <Label>Location Tracking</Label>
                                <div className="text-[13px] text-muted-foreground">Track via mobile app</div>
                            </div>
                            <Switch checked={form.location_tracking_enabled} onCheckedChange={v => setForm(f => ({ ...f, location_tracking_enabled: v }))} />
                        </div>
                    </div>
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={() => handleUpdate()} disabled={loading === user.id}>
                        {loading === user.id ? 'Saving…' : 'Save changes'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
        <ConfirmActionDialog confirmDialog={confirmDialog} setConfirmDialog={setConfirmDialog} />
        </>
    );
}

interface ConfirmDialogProps { confirmDialog: { open: boolean; title: string; description: string; onConfirm: () => void }; setConfirmDialog: (fn: (p: any) => any) => void; }

export function ConfirmActionDialog({ confirmDialog, setConfirmDialog }: ConfirmDialogProps) {
    return (
        <Dialog open={confirmDialog.open} onOpenChange={open => setConfirmDialog((prev: any) => ({ ...prev, open }))}>
            <DialogContent>
                <DialogHeader><DialogTitle>{confirmDialog.title}</DialogTitle><DialogDescription>{confirmDialog.description}</DialogDescription></DialogHeader>
                <DialogFooter><Button variant="ghost" onClick={() => setConfirmDialog((prev: any) => ({ ...prev, open: false }))}>Cancel</Button><Button variant="destructive" onClick={confirmDialog.onConfirm}>Confirm</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

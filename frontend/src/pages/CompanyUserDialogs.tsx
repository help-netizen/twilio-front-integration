import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogBody, DialogPanelHeader, DialogPanelFooter } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { FloatingField } from '../components/ui/floating-field';
import { FloatingSelect } from '../components/ui/floating-select';
import { Switch } from '../components/ui/switch';
import { Copy, Link2, Unlink, KeyRound, Ban, Power, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useEffect, useState } from 'react';
import { authedFetch } from '../services/apiClient';
import type { CompanyUser, EditUserForm } from '../hooks/useCompanyUsers';

// ─── Provider bridge (ALB-104) ───────────────────────────────────────────────
// Maps a CRM user to a Zenbooker team member so the assigned-only provider
// scope (PF007) can resolve job assignments to this user.

interface RosterMember { id: string; name: string }

function ZenbookerLinkField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
    const [roster, setRoster] = useState<RosterMember[] | null>(null);
    const [rosterError, setRosterError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        authedFetch('/api/zenbooker/team-members')
            .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
            .then(j => { if (!cancelled) setRoster((j.data || []).map((m: any) => ({ id: String(m.id), name: m.name || String(m.id) }))); })
            .catch(() => { if (!cancelled) { setRoster([]); setRosterError(true); } });
        return () => { cancelled = true; };
    }, []);

    const linked = !!value;
    const linkedName = roster?.find(m => m.id === value)?.name;

    return (
        <div className="space-y-2 rounded-xl p-3" style={{ background: 'rgba(25, 25, 25, 0.03)' }}>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className={`inline-block size-2 rounded-full ${linked ? 'bg-green-500' : 'bg-amber-400'}`} />
                    <Label className="text-sm">Zenbooker team member</Label>
                </div>
                {linked && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" onClick={() => onChange(null)}>
                        <Unlink className="size-3.5 mr-1" />Unlink
                    </Button>
                )}
            </div>

            {rosterError ? (
                <>
                    <Input
                        placeholder="Zenbooker team member ID"
                        value={value || ''}
                        onChange={e => onChange(e.target.value.trim() || null)}
                    />
                    <p className="text-[12px] text-muted-foreground">
                        Couldn't load the roster — paste the team member ID from Zenbooker.
                    </p>
                </>
            ) : roster === null ? (
                <div className="text-[13px] text-muted-foreground">Loading roster…</div>
            ) : (
                <>
                    <Select value={value || '__none__'} onValueChange={v => onChange(v === '__none__' ? null : v)}>
                        <SelectTrigger>
                            <SelectValue>
                                {linked
                                    ? <span className="flex items-center gap-1.5"><Link2 className="size-3.5" />{linkedName || value}</span>
                                    : 'Not linked'}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">Not linked</SelectItem>
                            {roster.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                        </SelectContent>
                    </Select>
                    <p className="text-[12px] text-muted-foreground">
                        {linked
                            ? 'Jobs assigned to this provider in Zenbooker are visible to this user.'
                            : 'Without a link, a provider with "assigned jobs only" sees no jobs.'}
                    </p>
                </>
            )}
        </div>
    );
}

type CreateForm = { full_name: string; email: string; phone: string; role_key: string; phone_calls_allowed: boolean; is_provider: boolean; schedule_color: string; location_tracking_enabled: boolean };
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
                                    <FloatingField id="user-email" label="Email" type="email" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} />
                                    <FloatingField id="user-phone" label="Phone (optional)" type="tel" value={createForm.phone} onChange={e => setCreateForm(f => ({ ...f, phone: e.target.value }))} />
                                    <FloatingSelect label="System role" value={createForm.role_key} onValueChange={v => setCreateForm(f => ({ ...f, role_key: v }))}>
                                        <SelectItem value="tenant_admin">Admin</SelectItem>
                                        <SelectItem value="manager">Manager</SelectItem>
                                        <SelectItem value="dispatcher">Dispatcher</SelectItem>
                                        <SelectItem value="provider">Field Provider</SelectItem>
                                    </FloatingSelect>

                                    {/* Schedule color — mirrors Edit profile */}
                                    <div className="space-y-2">
                                        <div className="blanc-eyebrow">Schedule color</div>
                                        <div className="flex items-center gap-3">
                                            <Input type="color" className="w-14 h-9 p-1 cursor-pointer bg-transparent" value={createForm.schedule_color} onChange={e => setCreateForm(f => ({ ...f, schedule_color: e.target.value }))} />
                                            <div className="text-sm font-mono text-muted-foreground uppercase">{createForm.schedule_color}</div>
                                        </div>
                                    </div>
                                </div>

                                {/* Operational settings — same toggles as Edit profile (Zenbooker
                                    link is configured later, in Edit, once the provider exists). */}
                                <div className="space-y-4">
                                    <div className="blanc-eyebrow">Operational settings</div>

                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <Label>Softphone Access</Label>
                                            <div className="text-[13px] text-muted-foreground">Can make/receive calls via browser</div>
                                        </div>
                                        <Switch checked={createForm.phone_calls_allowed} onCheckedChange={v => setCreateForm(f => ({ ...f, phone_calls_allowed: v }))} />
                                    </div>

                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <Label>Field Provider</Label>
                                            <div className="text-[13px] text-muted-foreground">Appears in scheduler and assignments</div>
                                        </div>
                                        <Switch checked={createForm.is_provider} onCheckedChange={v => setCreateForm(f => ({ ...f, is_provider: v }))} />
                                    </div>

                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <Label>Location Tracking</Label>
                                            <div className="text-[13px] text-muted-foreground">Track via mobile app</div>
                                        </div>
                                        <Switch checked={createForm.location_tracking_enabled} onCheckedChange={v => setCreateForm(f => ({ ...f, location_tracking_enabled: v }))} />
                                    </div>
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
    if (!user) return null;

    const isActive = user.membership_status === 'active';
    const busy = loading === user.id;

    const handleDisableToggle = () => {
        if (!onToggleStatus) return;
        if (isActive && !window.confirm(`Disable ${user.full_name || user.email}? They will lose access to the company.`)) return;
        onToggleStatus(user);
        setOpen(false);
    };

    const handleDelete = () => {
        if (!onDeleteUser) return;
        if (!window.confirm(`Permanently remove ${user.full_name || user.email} from the company? This unlinks their account and cannot be undone.`)) return;
        onDeleteUser(user);
    };

    return (
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
                        <div className="blanc-eyebrow">Identity</div>
                        <FloatingField id="edit-user-name" label="Full name" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            <FloatingField id="edit-user-email" label="Email (sign-in)" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                            <FloatingField id="edit-user-phone" label="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                        </div>
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
                        </div>
                        {/* #86: fully unlink a disabled user from the company (destructive). */}
                        {!isActive && onDeleteUser && (
                            <button
                                type="button"
                                disabled={busy}
                                onClick={handleDelete}
                                className="inline-flex items-center gap-1.5 text-[13px] font-medium disabled:opacity-50"
                                style={{ color: 'var(--blanc-danger)' }}
                            >
                                <Trash2 className="size-3.5" /> Remove from company
                            </button>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        {/* Role */}
                        <FloatingSelect label="Role" value={form.role_key} onValueChange={v => setForm(f => ({ ...f, role_key: v }))}>
                            <SelectItem value="tenant_admin">Admin</SelectItem>
                            <SelectItem value="manager">Manager</SelectItem>
                            <SelectItem value="dispatcher">Dispatcher</SelectItem>
                            <SelectItem value="provider">Field Provider</SelectItem>
                        </FloatingSelect>

                        {/* Schedule color — native color picker, kept as a labeled control */}
                        <div className="space-y-2">
                            <div className="blanc-eyebrow">Schedule color</div>
                            <div className="flex items-center gap-3">
                                <Input type="color" className="w-14 h-9 p-1 cursor-pointer bg-transparent" value={form.schedule_color} onChange={e => setForm(f => ({ ...f, schedule_color: e.target.value }))} />
                                <div className="text-sm font-mono text-muted-foreground uppercase">{form.schedule_color}</div>
                            </div>
                        </div>
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
                                <Label>Field Provider</Label>
                                <div className="text-[13px] text-muted-foreground">Appears in scheduler and assignments</div>
                            </div>
                            <Switch checked={form.is_provider} onCheckedChange={v => setForm(f => ({ ...f, is_provider: v }))} />
                        </div>

                        {form.is_provider && (
                            <ZenbookerLinkField
                                value={form.zenbooker_team_member_id}
                                onChange={v => setForm(f => ({ ...f, zenbooker_team_member_id: v }))}
                            />
                        )}

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

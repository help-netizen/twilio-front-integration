import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogBody, DialogPanelHeader, DialogPanelFooter } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { FloatingField } from '../components/ui/floating-field';
import { FloatingSelect } from '../components/ui/floating-select';
import { Switch } from '../components/ui/switch';
import { Copy, Link2, Unlink } from 'lucide-react';
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
        <div className="space-y-2 rounded-xl p-3" style={{ background: 'rgba(117, 106, 89, 0.04)' }}>
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
                            ? 'Jobs assigned to this technician in Zenbooker are visible to this user.'
                            : 'Without a link, a provider with "assigned jobs only" sees no jobs.'}
                    </p>
                </>
            )}
        </div>
    );
}

interface CreateDialogProps { open: boolean; setOpen: (v: boolean) => void; createForm: { full_name: string; email: string; role_key: string }; setCreateForm: (fn: (f: { full_name: string; email: string; role_key: string }) => { full_name: string; email: string; role_key: string }) => void; creating: boolean; tempPassword: string | null; setTempPassword: (v: string | null) => void; handleCreate: () => void; }

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
                                <div className="rounded-xl p-4" style={{ background: 'rgba(117, 106, 89, 0.04)' }}>
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
                                <div className="space-y-3.5">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                                        <FloatingField id="user-name" label="Full name" value={createForm.full_name} onChange={e => setCreateForm(f => ({ ...f, full_name: e.target.value }))} />
                                        <FloatingField id="user-email" label="Email" type="email" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} />
                                    </div>
                                    <FloatingSelect label="System role" value={createForm.role_key} onValueChange={v => setCreateForm(f => ({ ...f, role_key: v }))}>
                                        <SelectItem value="tenant_admin">Admin</SelectItem>
                                        <SelectItem value="manager">Manager</SelectItem>
                                        <SelectItem value="dispatcher">Dispatcher</SelectItem>
                                        <SelectItem value="provider">Field Provider</SelectItem>
                                    </FloatingSelect>
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
}

export function EditUserDialog({ open, setOpen, user, form, setForm, handleUpdate, loading }: EditUserDialogProps) {
    if (!user) return null;

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

                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <Label>Call Masking</Label>
                                <div className="text-[13px] text-muted-foreground">Proxy via Twilio proxy numbers</div>
                            </div>
                            <Switch checked={form.call_masking_enabled} onCheckedChange={v => setForm(f => ({ ...f, call_masking_enabled: v }))} />
                        </div>
                    </div>
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={handleUpdate} disabled={loading === user.id}>
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

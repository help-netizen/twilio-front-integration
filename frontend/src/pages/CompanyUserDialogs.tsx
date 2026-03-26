import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { CompanyUser, EditUserForm } from '../hooks/useCompanyUsers';

interface CreateDialogProps { open: boolean; setOpen: (v: boolean) => void; createForm: { full_name: string; email: string; role_key: string }; setCreateForm: (fn: (f: { full_name: string; email: string; role_key: string }) => { full_name: string; email: string; role_key: string }) => void; creating: boolean; tempPassword: string | null; setTempPassword: (v: string | null) => void; handleCreate: () => void; }

export function CreateUserDialog({ open, setOpen, createForm, setCreateForm, creating, tempPassword, setTempPassword, handleCreate }: CreateDialogProps) {
    return (
        <Dialog open={open} onOpenChange={o => { if (!o) setTempPassword(null); setOpen(o); }}>
            <DialogContent>
                <DialogHeader><DialogTitle>{tempPassword ? 'User Created' : 'Add New User'}</DialogTitle><DialogDescription>{tempPassword ? 'Share the temporary password with the user. It will only be shown once.' : 'The user will receive a temporary password and must change it on first login.'}</DialogDescription></DialogHeader>
                {tempPassword ? (
                    <div className="space-y-4 py-2">
                        <div className="rounded-lg border bg-muted/50 p-4"><Label className="text-xs text-muted-foreground">Temporary Password</Label><div className="flex items-center gap-2 mt-1"><code className="text-lg font-mono font-semibold flex-1">{tempPassword}</code><Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(tempPassword); toast.success('Copied!'); }}><Copy className="size-4" /></Button></div></div>
                        <DialogFooter><Button onClick={() => { setOpen(false); setTempPassword(null); }}>Done</Button></DialogFooter>
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        <div className="space-y-2"><Label htmlFor="user-name">Full Name *</Label><Input id="user-name" placeholder="John Doe" value={createForm.full_name} onChange={e => setCreateForm(f => ({ ...f, full_name: e.target.value }))} /></div>
                        <div className="space-y-2"><Label htmlFor="user-email">Email *</Label><Input id="user-email" type="email" placeholder="john@company.com" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} /></div>
                        <div className="space-y-2">
                            <Label>System Role</Label>
                            <Select value={createForm.role_key} onValueChange={v => setCreateForm(f => ({ ...f, role_key: v }))}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="tenant_admin">Admin</SelectItem>
                                    <SelectItem value="manager">Manager</SelectItem>
                                    <SelectItem value="dispatcher">Dispatcher</SelectItem>
                                    <SelectItem value="provider">Field Provider</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : 'Create User'}</Button></DialogFooter>
                    </div>
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
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Edit User Profile</DialogTitle>
                    <DialogDescription>
                        Update role and operational settings for <strong>{user.full_name}</strong>.
                    </DialogDescription>
                </DialogHeader>
                
                <div className="space-y-6 py-4">
                    {/* Role Selection */}
                    <div className="space-y-3">
                        <Label className="text-sm font-semibold">System Role</Label>
                        <Select value={form.role_key} onValueChange={v => setForm(f => ({ ...f, role_key: v }))}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="tenant_admin">Admin</SelectItem>
                                <SelectItem value="manager">Manager</SelectItem>
                                <SelectItem value="dispatcher">Dispatcher</SelectItem>
                                <SelectItem value="provider">Field Provider</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-4">
                        <Label className="text-sm font-semibold">Operational Settings</Label>
                        
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

                    <div className="space-y-3">
                        <Label className="text-sm font-semibold">Schedule Color</Label>
                        <div className="flex items-center gap-3">
                            <Input type="color" className="w-14 h-9 p-1 cursor-pointer" value={form.schedule_color} onChange={e => setForm(f => ({ ...f, schedule_color: e.target.value }))} />
                            <div className="text-sm font-mono text-muted-foreground uppercase">{form.schedule_color}</div>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={handleUpdate} disabled={loading === user.id}>
                        {loading === user.id ? 'Saving…' : 'Save Changes'}
                    </Button>
                </DialogFooter>
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
                <DialogFooter><Button variant="outline" onClick={() => setConfirmDialog((prev: any) => ({ ...prev, open: false }))}>Cancel</Button><Button variant="destructive" onClick={confirmDialog.onConfirm}>Confirm</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

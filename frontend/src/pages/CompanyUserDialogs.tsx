import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import type { CompanyUser } from '../hooks/useCompanyUsers';

interface CreateDialogProps { open: boolean; setOpen: (v: boolean) => void; createForm: { full_name: string; email: string; role: string }; setCreateForm: (fn: (f: { full_name: string; email: string; role: string }) => { full_name: string; email: string; role: string }) => void; creating: boolean; tempPassword: string | null; setTempPassword: (v: string | null) => void; handleCreate: () => void; }

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
                        <div className="space-y-2"><Label>Role</Label><Select value={createForm.role} onValueChange={v => setCreateForm(f => ({ ...f, role: v }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="company_member">Member</SelectItem><SelectItem value="company_admin">Admin</SelectItem></SelectContent></Select></div>
                        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : 'Create User'}</Button></DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

interface RoleDialogProps { roleDialog: { open: boolean; user: CompanyUser | null; newRole: string }; setRoleDialog: (fn: (p: any) => any) => void; handleRoleChange: () => void; actionLoading: string | null; }

export function RoleChangeDialog({ roleDialog, setRoleDialog, handleRoleChange, actionLoading }: RoleDialogProps) {
    return (
        <Dialog open={roleDialog.open} onOpenChange={open => setRoleDialog((prev: any) => ({ ...prev, open }))}>
            <DialogContent>
                <DialogHeader><DialogTitle>Change Role</DialogTitle><DialogDescription>Change role for <strong>{roleDialog.user?.full_name}</strong> from <Badge variant="secondary" className="mx-1">{roleDialog.user?.membership_role === 'company_admin' ? 'Admin' : 'Member'}</Badge> to <Badge variant="default" className="mx-1">{roleDialog.newRole === 'company_admin' ? 'Admin' : 'Member'}</Badge></DialogDescription></DialogHeader>
                <DialogFooter><Button variant="outline" onClick={() => setRoleDialog((prev: any) => ({ ...prev, open: false }))}>Cancel</Button><Button onClick={handleRoleChange} disabled={actionLoading === roleDialog.user?.id}>{actionLoading === roleDialog.user?.id ? 'Saving…' : 'Confirm'}</Button></DialogFooter>
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

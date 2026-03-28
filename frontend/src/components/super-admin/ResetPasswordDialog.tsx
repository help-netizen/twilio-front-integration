import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import type { CompanyUser } from '../../hooks/useCompanyUsers';

interface ResetPasswordDialogProps {
    open: boolean;
    setOpen: (v: boolean) => void;
    user: CompanyUser | null;
    loading: boolean;
    tempPassword: string | null;
    setTempPassword: (v: string | null) => void;
    handleReset: () => void;
}

export function ResetPasswordDialog({ open, setOpen, user, loading, tempPassword, setTempPassword, handleReset }: ResetPasswordDialogProps) {
    if (!user) return null;

    return (
        <Dialog open={open} onOpenChange={o => { if (!o) setTempPassword(null); setOpen(o); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{tempPassword ? 'Password Reset Complete' : 'Reset Password'}</DialogTitle>
                    <DialogDescription>
                        {tempPassword
                            ? 'Share the new temporary password with the user. It will only be shown once.'
                            : <>Reset password for <strong>{user.full_name}</strong> ({user.email}). A new temporary password will be generated.</>
                        }
                    </DialogDescription>
                </DialogHeader>

                {tempPassword ? (
                    <div className="space-y-4 py-2">
                        <div className="rounded-lg border bg-muted/50 p-4">
                            <Label className="text-xs text-muted-foreground">Temporary Password</Label>
                            <div className="flex items-center gap-2 mt-1">
                                <code className="text-lg font-mono font-semibold flex-1">{tempPassword}</code>
                                <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(tempPassword); toast.success('Copied!'); }}>
                                    <Copy className="size-4" />
                                </Button>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">The user will be required to change this password on their next login.</p>
                        <DialogFooter>
                            <Button onClick={() => { setOpen(false); setTempPassword(null); }}>Done</Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
                            <KeyRound className="size-5 text-muted-foreground flex-shrink-0" />
                            <div className="text-sm">
                                This will generate a new temporary password and invalidate the current password. The user will need to change the password on next login.
                            </div>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                            <Button onClick={handleReset} disabled={loading}>
                                {loading ? 'Resetting...' : 'Reset Password'}
                            </Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

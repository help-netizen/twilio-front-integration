import { useState, useEffect } from 'react';
import { authedFetch } from '../../services/apiClient';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Copy, Key, Mail, Check, ShieldCheck, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import type { PlatformUser } from '../../hooks/usePlatformAdmin';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

type Stage = 'choose' | 'temp' | 'email';

interface Props {
    user: PlatformUser | null;
    open: boolean;
    setOpen: (v: boolean) => void;
}

/**
 * Platform-wide (super-admin) password reset. Owner chose BOTH delivery paths:
 *  - "temp": server returns a one-time password, shown once to hand to the user.
 *  - "email": Keycloak emails a secure update-password link; no password is
 *    ever surfaced in this branch.
 * Center modal — short action, not entity editing (form canon).
 */
export function PlatformResetPasswordDialog({ user, open, setOpen }: Props) {
    const [stage, setStage] = useState<Stage>('choose');
    const [busy, setBusy] = useState<null | 'temp' | 'email'>(null);
    const [tempPassword, setTempPassword] = useState('');
    const [copied, setCopied] = useState(false);

    // fresh state whenever the dialog (re)opens
    useEffect(() => {
        if (open) { setStage('choose'); setBusy(null); setTempPassword(''); setCopied(false); }
    }, [open, user?.id]);

    if (!user) return null;

    const submit = async (mode: 'temp' | 'email') => {
        setBusy(mode);
        try {
            const res = await authedFetch(`${API_BASE}/platform/users/${user.id}/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) { toast.error(json.message || 'Failed to reset password'); return; }
            if (mode === 'temp') { setTempPassword(json.temporary_password || ''); setStage('temp'); }
            else { setStage('email'); }
        } catch {
            toast.error('Connection error');
        } finally {
            setBusy(null);
        }
    };

    const copy = () => {
        navigator.clipboard.writeText(tempPassword);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
    };

    const firstName = user.full_name?.split(' ')[0] || 'the user';

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {stage === 'temp' ? 'Temporary password' : stage === 'email' ? 'Reset link sent' : 'Reset password'}
                    </DialogTitle>
                    <DialogDescription>
                        {stage === 'choose'
                            ? <>Reset the password for <strong>{user.full_name}</strong> ({user.email}).</>
                            : stage === 'temp'
                                ? 'Shown once — share it with the user now.'
                                : `A secure link was emailed to ${user.email}.`}
                    </DialogDescription>
                </DialogHeader>

                {stage === 'choose' && (
                    <div className="space-y-2.5 py-1">
                        <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => submit('temp')}
                            className="flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition-colors hover:bg-muted/40 disabled:opacity-60"
                        >
                            <Key className="size-5 shrink-0 text-primary" />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold">{busy === 'temp' ? 'Generating…' : 'Show temporary password'}</div>
                                <div className="text-xs text-muted-foreground">Generate a one-time password to hand over. Changed at first login.</div>
                            </div>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                        <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => submit('email')}
                            className="flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition-colors hover:bg-muted/40 disabled:opacity-60"
                        >
                            <Mail className="size-5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold">{busy === 'email' ? 'Sending…' : 'Send reset email'}</div>
                                <div className="text-xs text-muted-foreground">Email the user a secure link to set their own password.</div>
                            </div>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                    </div>
                )}

                {stage === 'temp' && (
                    <div className="space-y-4 py-2">
                        <div className="rounded-lg border bg-muted/50 p-4">
                            <Label className="text-xs text-muted-foreground">Temporary password</Label>
                            <div className="mt-1 flex items-center gap-2">
                                <code className="flex-1 truncate font-mono text-lg font-semibold">{tempPassword}</code>
                                <Button variant="outline" size="sm" onClick={copy}>
                                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                </Button>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">Share it with {firstName}. They'll be required to change it at next login.</p>
                        <DialogFooter>
                            <Button onClick={() => setOpen(false)}>Done</Button>
                        </DialogFooter>
                    </div>
                )}

                {stage === 'email' && (
                    <div className="space-y-4 py-3 text-center">
                        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-emerald-500/10">
                            <ShieldCheck className="size-5 text-emerald-600" />
                        </div>
                        <p className="text-sm">Reset link sent to <span className="font-semibold">{user.email}</span>.</p>
                        <DialogFooter className="sm:justify-center">
                            <Button onClick={() => setOpen(false)}>Done</Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

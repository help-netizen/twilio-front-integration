import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogPanelHeader, DialogBody, DialogPanelFooter } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { FloatingField } from '../components/ui/floating-field';
import { Copy, ShieldCheck, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { Integration } from '../services/integrationsApi';

function copyToClipboard(text: string, label: string) { navigator.clipboard.writeText(text); toast.success(`${label} copied to clipboard`); }

interface CreateDialogProps { open: boolean; onOpenChange: (o: boolean) => void; clientName: string; setClientName: (v: string) => void; onSubmit: () => void; isPending: boolean; }
export function CreateDialog({ open, onOpenChange, clientName, setClientName, onSubmit, isPending }: CreateDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="text-[22px] font-semibold leading-tight" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>Create Integration</DialogTitle>
                    <DialogDescription className="sr-only">Generate API credentials for a lead generator. The secret will be shown only once.</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-sm text-[var(--blanc-ink-2)]">Generate API credentials for a lead generator. The secret will be shown only once.</p>
                        <FloatingField id="client-name" label="Client Name" value={clientName} onChange={e => setClientName(e.target.value)} onKeyDown={e => e.key === 'Enter' && onSubmit()} />
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={onSubmit} disabled={!clientName.trim() || isPending}>{isPending ? 'Creating…' : 'Create'}</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

interface SecretDialogProps { open: boolean; onOpenChange: (o: boolean) => void; integration: Integration | null; }
export function SecretDialog({ open, onOpenChange, integration }: SecretDialogProps) {
    const [secretVisible, setSecretVisible] = useState(false);
    return (
        <Dialog open={open} onOpenChange={o => { if (!o) setSecretVisible(false); onOpenChange(o); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="flex items-center gap-2 text-[22px] font-semibold leading-tight" style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}><ShieldCheck className="h-5 w-5 text-[var(--blanc-success)]" />Integration Created</DialogTitle>
                    <DialogDescription className="sr-only">Save these credentials now. The secret will not be shown again.</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-sm text-[var(--blanc-ink-2)]">Save these credentials now. The secret will <strong>not</strong> be shown again.</p>
                        {integration && (
                            <div className="space-y-4">
                                <div><div className="blanc-eyebrow">Client</div><p className="font-medium text-[var(--blanc-ink-1)] mt-1">{integration.client_name}</p></div>
                                <div><div className="blanc-eyebrow">X-BLANC-API-KEY</div><div className="flex items-center gap-2 mt-1"><code className="flex-1 bg-[rgba(117,106,89,0.04)] px-3 py-2 rounded text-sm font-mono break-all">{integration.key_id}</code><Button variant="outline" size="sm" onClick={() => copyToClipboard(integration.key_id, 'API Key')}><Copy className="h-4 w-4" /></Button></div></div>
                                <div><div className="blanc-eyebrow">X-BLANC-API-SECRET</div><div className="flex items-center gap-2 mt-1"><code className="flex-1 bg-[rgba(178,106,29,0.08)] border border-[var(--blanc-line)] px-3 py-2 rounded text-sm font-mono break-all">{secretVisible ? integration.secret : '•'.repeat(48)}</code><Button variant="outline" size="sm" onClick={() => setSecretVisible(!secretVisible)}>{secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button><Button variant="outline" size="sm" onClick={() => copyToClipboard(integration.secret || '', 'API Secret')}><Copy className="h-4 w-4" /></Button></div><p className="text-xs text-[var(--blanc-warning)] mt-2 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />This secret will not be shown again after closing this dialog.</p></div>
                                <div><div className="blanc-eyebrow">Example Usage</div><pre className="mt-1 bg-[rgba(117,106,89,0.04)] px-3 py-2 rounded text-xs font-mono overflow-x-auto whitespace-pre">{`curl -X POST https://your-domain/api/v1/integrations/leads \\
  -H "Content-Type: application/json" \\
  -H "X-BLANC-API-KEY: ${integration.key_id}" \\
  -H "X-BLANC-API-SECRET: ${secretVisible ? integration.secret : '****'}" \\
  -d '{"FirstName":"John","Phone":"+16195551234"}'`}</pre></div>
                            </div>
                        )}
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button onClick={() => { onOpenChange(false); setSecretVisible(false); }}>I've saved the credentials</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

interface RevokeDialogProps { target: Integration | null; onClose: () => void; onRevoke: () => void; isPending: boolean; }
export function RevokeDialog({ target, onClose, onRevoke, isPending }: RevokeDialogProps) {
    return (
        <Dialog open={!!target} onOpenChange={o => !o && onClose()}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="flex items-center gap-2 text-[22px] font-semibold leading-tight text-[var(--blanc-danger)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}><AlertTriangle className="h-5 w-5" />Revoke Integration</DialogTitle>
                    <DialogDescription className="sr-only">Revoke this integration's credentials.</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-sm text-[var(--blanc-ink-2)]">Are you sure you want to revoke <strong>{target?.client_name}</strong>? This action cannot be undone — the integration will immediately stop working.</p>
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button variant="destructive" onClick={onRevoke} disabled={isPending}>{isPending ? 'Revoking…' : 'Revoke'}</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

interface RegenerateDialogProps { open: boolean; onOpenChange: (o: boolean) => void; onRegenerate: () => void; isPending: boolean; }
export function RegenerateDialog({ open, onOpenChange, onRegenerate, isPending }: RegenerateDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle className="flex items-center gap-2 text-[22px] font-semibold leading-tight text-[var(--blanc-warning)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}><AlertTriangle className="h-5 w-5" />Regenerate Webhook URL</DialogTitle>
                    <DialogDescription className="sr-only">Generate a new webhook URL and invalidate the current one.</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <p className="text-sm text-[var(--blanc-ink-2)]">This will generate a new webhook URL and <strong>invalidate the current one</strong>. You will need to update the URL in Zenbooker settings.</p>
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={onRegenerate} disabled={isPending}>{isPending ? 'Regenerating…' : 'Regenerate'}</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

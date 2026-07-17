import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Copy, ShieldCheck, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { Integration } from '../services/integrationsApi';

function copyToClipboard(text: string, label: string) { navigator.clipboard.writeText(text); toast.success(`${label} copied to clipboard`); }

interface CreateDialogProps { open: boolean; onOpenChange: (o: boolean) => void; clientName: string; setClientName: (v: string) => void; onSubmit: () => void; isPending: boolean; }
export function CreateDialog({ open, onOpenChange, clientName, setClientName, onSubmit, isPending }: CreateDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent><DialogHeader><DialogTitle>Create Integration</DialogTitle><DialogDescription>Generate API credentials for a lead generator. The secret will be shown only once.</DialogDescription></DialogHeader>
                <div className="py-4"><Label htmlFor="client-name">Client Name</Label><Input id="client-name" placeholder="e.g. Service Direct, Elocal" value={clientName} onChange={e => setClientName(e.target.value)} onKeyDown={e => e.key === 'Enter' && onSubmit()} className="mt-2" /></div>
                <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={onSubmit} disabled={!clientName.trim() || isPending}>{isPending ? 'Creating…' : 'Create'}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface SecretDialogProps { open: boolean; onOpenChange: (o: boolean) => void; integration: Integration | null; }
export function SecretDialog({ open, onOpenChange, integration }: SecretDialogProps) {
    const [secretVisible, setSecretVisible] = useState(false);
    return (
        <Dialog open={open} onOpenChange={o => { if (!o) setSecretVisible(false); onOpenChange(o); }}>
            <DialogContent className="max-w-lg"><DialogHeader><DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-emerald-600" />Integration Created</DialogTitle><DialogDescription>Save these credentials now. The secret will <strong>not</strong> be shown again.</DialogDescription></DialogHeader>
                {integration && (
                    <div className="space-y-4 py-4">
                        <div><Label className="text-xs text-muted-foreground">Client</Label><p className="font-medium">{integration.client_name}</p></div>
                        <div><Label className="text-xs text-muted-foreground">X-BLANC-API-KEY</Label><div className="flex items-center gap-2 mt-1"><code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono break-all">{integration.key_id}</code><Button variant="outline" size="sm" onClick={() => copyToClipboard(integration.key_id, 'API Key')}><Copy className="h-4 w-4" /></Button></div></div>
                        <div><Label className="text-xs text-muted-foreground">X-BLANC-API-SECRET</Label><div className="flex items-center gap-2 mt-1"><code className="flex-1 bg-amber-50 border border-amber-200 px-3 py-2 rounded text-sm font-mono break-all">{secretVisible ? integration.secret : '•'.repeat(48)}</code><Button variant="outline" size="sm" onClick={() => setSecretVisible(!secretVisible)}>{secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button><Button variant="outline" size="sm" onClick={() => copyToClipboard(integration.secret || '', 'API Secret')}><Copy className="h-4 w-4" /></Button></div><p className="text-xs text-amber-600 mt-2 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />This secret will not be shown again after closing this dialog.</p></div>
                        <div><Label className="text-xs text-muted-foreground">Example Usage</Label><pre className="mt-1 bg-muted px-3 py-2 rounded text-xs font-mono overflow-x-auto whitespace-pre">{`curl -X POST https://your-domain/api/v1/integrations/leads \\
  -H "Content-Type: application/json" \\
  -H "X-BLANC-API-KEY: ${integration.key_id}" \\
  -H "X-BLANC-API-SECRET: ${secretVisible ? integration.secret : '****'}" \\
  -d '{"FirstName":"John","Phone":"+16195551234"}'`}</pre></div>
                    </div>
                )}
                <DialogFooter><Button onClick={() => { onOpenChange(false); setSecretVisible(false); }}>I've saved the credentials</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface RevokeDialogProps { target: Integration | null; onClose: () => void; onRevoke: () => void; isPending: boolean; }
export function RevokeDialog({ target, onClose, onRevoke, isPending }: RevokeDialogProps) {
    return (
        <Dialog open={!!target} onOpenChange={o => !o && onClose()}>
            <DialogContent><DialogHeader><DialogTitle className="flex items-center gap-2 text-red-600"><AlertTriangle className="h-5 w-5" />Revoke Integration</DialogTitle><DialogDescription>Are you sure you want to revoke <strong>{target?.client_name}</strong>? This action cannot be undone — the integration will immediately stop working.</DialogDescription></DialogHeader>
                <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="destructive" onClick={onRevoke} disabled={isPending}>{isPending ? 'Revoking…' : 'Revoke'}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface RegenerateDialogProps { open: boolean; onOpenChange: (o: boolean) => void; onRegenerate: () => void; isPending: boolean; }
export function RegenerateDialog({ open, onOpenChange, onRegenerate, isPending }: RegenerateDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent><DialogHeader><DialogTitle className="flex items-center gap-2 text-amber-600"><AlertTriangle className="h-5 w-5" />Regenerate Webhook URL</DialogTitle><DialogDescription>This will generate a new webhook URL and <strong>invalidate the current one</strong>. You will need to update the URL in Zenbooker settings.</DialogDescription></DialogHeader>
                <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={onRegenerate} disabled={isPending}>{isPending ? 'Regenerating…' : 'Regenerate'}</Button></DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    fetchIntegrations,
    createIntegration,
    revokeIntegration,
    fetchWebhookUrl,
    regenerateWebhookUrl,
    type Integration,
} from '../services/integrationsApi';
import {
    Table,
    TableHeader,
    TableRow,
    TableHead,
    TableBody,
    TableCell,
} from '../components/ui/table';
import { Button } from '../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import {
    Plus,
    Copy,
    ShieldCheck,
    ShieldOff,
    Eye,
    EyeOff,
    Key,
    AlertTriangle,
    Webhook,
    RefreshCw,
    Check,
} from 'lucide-react';

export function IntegrationsPage() {
    const queryClient = useQueryClient();
    const [createOpen, setCreateOpen] = useState(false);
    const [secretModalOpen, setSecretModalOpen] = useState(false);
    const [newIntegration, setNewIntegration] = useState<Integration | null>(null);
    const [secretVisible, setSecretVisible] = useState(false);
    const [clientName, setClientName] = useState('');
    const [revokeTarget, setRevokeTarget] = useState<Integration | null>(null);
    const [regenerateOpen, setRegenerateOpen] = useState(false);
    const [webhookCopied, setWebhookCopied] = useState(false);

    const { data: integrations = [], isLoading } = useQuery({
        queryKey: ['integrations'],
        queryFn: fetchIntegrations,
    });

    // Zenbooker webhook URL
    const { data: webhookData, isLoading: webhookLoading } = useQuery({
        queryKey: ['zenbooker-webhook-url'],
        queryFn: fetchWebhookUrl,
    });

    const regenerateMutation = useMutation({
        mutationFn: regenerateWebhookUrl,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['zenbooker-webhook-url'] });
            setRegenerateOpen(false);
            toast.success('Webhook URL regenerated');
        },
        onError: () => toast.error('Failed to regenerate webhook URL'),
    });

    const createMutation = useMutation({
        mutationFn: createIntegration,
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['integrations'] });
            setNewIntegration(result);
            setCreateOpen(false);
            setSecretModalOpen(true);
            setClientName('');
            toast.success('Integration created');
        },
        onError: () => toast.error('Failed to create integration'),
    });

    const revokeMutation = useMutation({
        mutationFn: revokeIntegration,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['integrations'] });
            setRevokeTarget(null);
            toast.success('Integration revoked');
        },
        onError: () => toast.error('Failed to revoke integration'),
    });

    function handleCreate() {
        if (!clientName.trim()) return;
        createMutation.mutate({ client_name: clientName.trim() });
    }

    function copyToClipboard(text: string, label: string) {
        navigator.clipboard.writeText(text);
        toast.success(`${label} copied to clipboard`);
    }

    function copyWebhookUrl() {
        if (!webhookData?.url) return;
        navigator.clipboard.writeText(webhookData.url);
        setWebhookCopied(true);
        toast.success('Webhook URL copied to clipboard');
        setTimeout(() => setWebhookCopied(false), 2000);
    }

    function getStatusBadge(integration: Integration) {
        if (integration.revoked_at) {
            return <Badge variant="destructive">Revoked</Badge>;
        }
        if (integration.expires_at && new Date(integration.expires_at) < new Date()) {
            return <Badge variant="secondary">Expired</Badge>;
        }
        return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Active</Badge>;
    }

    function formatDate(dateStr: string | null) {
        if (!dateStr) return '—';
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    return (
        <div className="p-6 max-w-5xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-semibold">Integrations</h1>
                <p className="text-muted-foreground text-sm mt-1">
                    Manage webhooks and API credentials
                </p>
            </div>

            <Separator className="mb-6" />

            {/* Zenbooker Webhook URL */}
            <div className="border rounded-lg p-5 mb-8 bg-card">
                <div className="flex items-center gap-2 mb-1">
                    <Webhook className="h-5 w-5 text-indigo-600" />
                    <h2 className="text-lg font-semibold">Zenbooker Webhooks</h2>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                    Paste this URL into Zenbooker → Settings → Webhooks for all event types you want to receive.
                </p>

                {webhookLoading ? (
                    <div className="text-sm text-muted-foreground">Loading webhook URL…</div>
                ) : webhookData?.url ? (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <code className="flex-1 bg-muted px-3 py-2.5 rounded text-sm font-mono break-all select-all">
                                {webhookData.url}
                            </code>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={copyWebhookUrl}
                                className="shrink-0"
                            >
                                {webhookCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRegenerateOpen(true)}
                                className="shrink-0"
                                title="Generate new URL (invalidates old one)"
                            >
                                <RefreshCw className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            This URL works for all webhook event types: jobs, customers, invoices, etc.
                        </p>
                    </div>
                ) : (
                    <div className="text-sm text-red-500">Failed to load webhook URL</div>
                )}
            </div>

            <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">API Keys</h2>
                <Button onClick={() => setCreateOpen(true)} size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    Create Integration
                </Button>
            </div>
            {isLoading ? (
                <div className="text-center text-muted-foreground py-12">Loading…</div>
            ) : integrations.length === 0 ? (
                <div className="text-center py-12">
                    <Key className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">No integrations yet</p>
                    <p className="text-sm text-muted-foreground mt-1">
                        Create your first integration to start accepting leads via API.
                    </p>
                </div>
            ) : (
                <div className="border rounded-lg overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/50">
                                <TableHead className="font-semibold">Client</TableHead>
                                <TableHead className="font-semibold">API Key</TableHead>
                                <TableHead className="font-semibold">Status</TableHead>
                                <TableHead className="font-semibold">Scopes</TableHead>
                                <TableHead className="font-semibold">Last Used</TableHead>
                                <TableHead className="font-semibold">Created</TableHead>
                                <TableHead className="font-semibold text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {integrations.map((integration) => (
                                <TableRow key={integration.id}>
                                    <TableCell className="font-medium">{integration.client_name}</TableCell>
                                    <TableCell>
                                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                                            {integration.key_id.slice(0, 12)}…
                                        </code>
                                        <button
                                            onClick={() => copyToClipboard(integration.key_id, 'API Key')}
                                            className="ml-2 text-muted-foreground hover:text-foreground transition-colors"
                                            title="Copy full key"
                                        >
                                            <Copy className="h-3.5 w-3.5 inline" />
                                        </button>
                                    </TableCell>
                                    <TableCell>{getStatusBadge(integration)}</TableCell>
                                    <TableCell>
                                        <div className="flex gap-1 flex-wrap">
                                            {(integration.scopes || []).map((scope) => (
                                                <Badge key={scope} variant="outline" className="text-xs">
                                                    {scope}
                                                </Badge>
                                            ))}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {formatDate(integration.last_used_at)}
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                        {formatDate(integration.created_at)}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {!integration.revoked_at && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                                onClick={() => setRevokeTarget(integration)}
                                            >
                                                <ShieldOff className="h-4 w-4 mr-1" />
                                                Revoke
                                            </Button>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {/* Create Dialog */}
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Integration</DialogTitle>
                        <DialogDescription>
                            Generate API credentials for a lead generator. The secret will be shown only once.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <Label htmlFor="client-name">Client Name</Label>
                        <Input
                            id="client-name"
                            placeholder="e.g. Service Direct, Elocal"
                            value={clientName}
                            onChange={(e) => setClientName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                            className="mt-2"
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCreateOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleCreate}
                            disabled={!clientName.trim() || createMutation.isPending}
                        >
                            {createMutation.isPending ? 'Creating…' : 'Create'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Secret Display Modal (shown ONCE after creation) */}
            <Dialog open={secretModalOpen} onOpenChange={(open) => {
                if (!open) setSecretVisible(false);
                setSecretModalOpen(open);
            }}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <ShieldCheck className="h-5 w-5 text-emerald-600" />
                            Integration Created
                        </DialogTitle>
                        <DialogDescription>
                            Save these credentials now. The secret will <strong>not</strong> be shown again.
                        </DialogDescription>
                    </DialogHeader>

                    {newIntegration && (
                        <div className="space-y-4 py-4">
                            {/* Client Name */}
                            <div>
                                <Label className="text-xs text-muted-foreground">Client</Label>
                                <p className="font-medium">{newIntegration.client_name}</p>
                            </div>

                            {/* API Key */}
                            <div>
                                <Label className="text-xs text-muted-foreground">X-BLANC-API-KEY</Label>
                                <div className="flex items-center gap-2 mt-1">
                                    <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono break-all">
                                        {newIntegration.key_id}
                                    </code>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => copyToClipboard(newIntegration.key_id, 'API Key')}
                                    >
                                        <Copy className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>

                            {/* API Secret */}
                            <div>
                                <Label className="text-xs text-muted-foreground">X-BLANC-API-SECRET</Label>
                                <div className="flex items-center gap-2 mt-1">
                                    <code className="flex-1 bg-amber-50 border border-amber-200 px-3 py-2 rounded text-sm font-mono break-all">
                                        {secretVisible ? newIntegration.secret : '•'.repeat(48)}
                                    </code>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setSecretVisible(!secretVisible)}
                                    >
                                        {secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => copyToClipboard(newIntegration.secret || '', 'API Secret')}
                                    >
                                        <Copy className="h-4 w-4" />
                                    </Button>
                                </div>
                                <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3" />
                                    This secret will not be shown again after closing this dialog.
                                </p>
                            </div>

                            {/* Usage example */}
                            <div>
                                <Label className="text-xs text-muted-foreground">Example Usage</Label>
                                <pre className="mt-1 bg-muted px-3 py-2 rounded text-xs font-mono overflow-x-auto whitespace-pre">
                                    {`curl -X POST https://your-domain/api/v1/integrations/leads \\
  -H "Content-Type: application/json" \\
  -H "X-BLANC-API-KEY: ${newIntegration.key_id}" \\
  -H "X-BLANC-API-SECRET: ${secretVisible ? newIntegration.secret : '****'}" \\
  -d '{"FirstName":"John","Phone":"+16195551234"}'`}
                                </pre>
                            </div>
                        </div>
                    )}

                    <DialogFooter>
                        <Button onClick={() => { setSecretModalOpen(false); setSecretVisible(false); }}>
                            I've saved the credentials
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Revoke Confirmation Dialog */}
            <Dialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-red-600">
                            <AlertTriangle className="h-5 w-5" />
                            Revoke Integration
                        </DialogTitle>
                        <DialogDescription>
                            Are you sure you want to revoke <strong>{revokeTarget?.client_name}</strong>?
                            This action cannot be undone — the integration will immediately stop working.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRevokeTarget(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.key_id)}
                            disabled={revokeMutation.isPending}
                        >
                            {revokeMutation.isPending ? 'Revoking…' : 'Revoke'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Regenerate Webhook URL Confirmation */}
            <Dialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-amber-600">
                            <AlertTriangle className="h-5 w-5" />
                            Regenerate Webhook URL
                        </DialogTitle>
                        <DialogDescription>
                            This will generate a new webhook URL and <strong>invalidate the current one</strong>.
                            You will need to update the URL in Zenbooker settings.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRegenerateOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => regenerateMutation.mutate()}
                            disabled={regenerateMutation.isPending}
                        >
                            {regenerateMutation.isPending ? 'Regenerating…' : 'Regenerate'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

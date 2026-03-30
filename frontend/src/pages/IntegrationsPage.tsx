import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchIntegrations, createIntegration, revokeIntegration, fetchWebhookUrl, regenerateWebhookUrl, fetchZenbookerApiKey, saveZenbookerApiKey, type Integration } from '../services/integrationsApi';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/table';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { Input } from '../components/ui/input';
import { Plus, Copy, ShieldOff, Key, Webhook, RefreshCw, Check, Settings2, Save, Trash2 } from 'lucide-react';
import { CreateDialog, SecretDialog, RevokeDialog, RegenerateDialog } from './IntegrationDialogs';

export function IntegrationsPage() {
    const queryClient = useQueryClient();
    const [createOpen, setCreateOpen] = useState(false);
    const [secretModalOpen, setSecretModalOpen] = useState(false);
    const [newIntegration, setNewIntegration] = useState<Integration | null>(null);
    const [clientName, setClientName] = useState('');
    const [revokeTarget, setRevokeTarget] = useState<Integration | null>(null);
    const [regenerateOpen, setRegenerateOpen] = useState(false);
    const [webhookCopied, setWebhookCopied] = useState(false);
    const [zbApiKeyInput, setZbApiKeyInput] = useState('');
    const [zbApiKeyEditing, setZbApiKeyEditing] = useState(false);

    const { data: integrations = [], isLoading } = useQuery({ queryKey: ['integrations'], queryFn: fetchIntegrations });
    const { data: webhookData, isLoading: webhookLoading } = useQuery({ queryKey: ['zenbooker-webhook-url'], queryFn: fetchWebhookUrl });
    const { data: zbApiKeyStatus, isLoading: zbApiKeyLoading } = useQuery({ queryKey: ['zenbooker-api-key'], queryFn: fetchZenbookerApiKey });

    const regenerateMutation = useMutation({ mutationFn: regenerateWebhookUrl, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['zenbooker-webhook-url'] }); setRegenerateOpen(false); toast.success('Webhook URL regenerated'); }, onError: () => toast.error('Failed to regenerate webhook URL') });
    const zbApiKeySaveMutation = useMutation({ mutationFn: (key: string | null) => saveZenbookerApiKey(key), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['zenbooker-api-key'] }); setZbApiKeyEditing(false); setZbApiKeyInput(''); toast.success('Zenbooker API key updated'); }, onError: () => toast.error('Failed to update Zenbooker API key') });
    const createMutation = useMutation({ mutationFn: createIntegration, onSuccess: (result) => { queryClient.invalidateQueries({ queryKey: ['integrations'] }); setNewIntegration(result); setCreateOpen(false); setSecretModalOpen(true); setClientName(''); toast.success('Integration created'); }, onError: () => toast.error('Failed to create integration') });
    const revokeMutation = useMutation({ mutationFn: revokeIntegration, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['integrations'] }); setRevokeTarget(null); toast.success('Integration revoked'); }, onError: () => toast.error('Failed to revoke integration') });

    function handleCreate() { if (!clientName.trim()) return; createMutation.mutate({ client_name: clientName.trim() }); }
    function copyToClipboard(text: string, label: string) { navigator.clipboard.writeText(text); toast.success(`${label} copied to clipboard`); }
    function copyWebhookUrl() { if (!webhookData?.url) return; navigator.clipboard.writeText(webhookData.url); setWebhookCopied(true); toast.success('Webhook URL copied to clipboard'); setTimeout(() => setWebhookCopied(false), 2000); }
    function getStatusBadge(integration: Integration) { if (integration.revoked_at) return <Badge variant="destructive">Revoked</Badge>; if (integration.expires_at && new Date(integration.expires_at) < new Date()) return <Badge variant="secondary">Expired</Badge>; return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Active</Badge>; }
    function formatDate(dateStr: string | null) { if (!dateStr) return '—'; return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }

    return (
        <div className="p-6 max-w-5xl mx-auto">
            <div className="mb-6"><h1 className="text-2xl font-semibold">Integrations</h1><p className="text-muted-foreground text-sm mt-1">Manage webhooks and API credentials</p></div>
            <Separator className="mb-6" />

            <div className="border rounded-lg p-5 mb-8 bg-card">
                <div className="flex items-center gap-2 mb-1"><Webhook className="h-5 w-5 text-indigo-600" /><h2 className="text-lg font-semibold">Zenbooker Webhooks</h2></div>
                <p className="text-sm text-muted-foreground mb-4">Paste this URL into Zenbooker → Settings → Webhooks for all event types you want to receive.</p>
                {webhookLoading ? <div className="text-sm text-muted-foreground">Loading webhook URL…</div> : webhookData?.url ? (
                    <div className="space-y-3"><div className="flex items-center gap-2"><code className="flex-1 bg-muted px-3 py-2.5 rounded text-sm font-mono break-all select-all">{webhookData.url}</code><Button variant="outline" size="sm" onClick={copyWebhookUrl} className="shrink-0">{webhookCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}</Button><Button variant="outline" size="sm" onClick={() => setRegenerateOpen(true)} className="shrink-0" title="Generate new URL (invalidates old one)"><RefreshCw className="h-4 w-4" /></Button></div><p className="text-xs text-muted-foreground">This URL works for all webhook event types: jobs, customers, invoices, etc.</p></div>
                ) : <div className="text-sm text-red-500">Failed to load webhook URL</div>}
            </div>

            <div className="border rounded-lg p-5 mb-8 bg-card">
                <div className="flex items-center gap-2 mb-1"><Settings2 className="h-5 w-5 text-amber-600" /><h2 className="text-lg font-semibold">Zenbooker API Key</h2></div>
                <p className="text-sm text-muted-foreground mb-4">Configure your Zenbooker API key to enable jobs sync and customer data import for this company.</p>
                {zbApiKeyLoading ? <div className="text-sm text-muted-foreground">Loading...</div> : (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            {zbApiKeyEditing ? (
                                <>
                                    <Input type="password" placeholder="Enter Zenbooker API key" value={zbApiKeyInput} onChange={e => setZbApiKeyInput(e.target.value)} className="flex-1 font-mono text-sm" />
                                    <Button size="sm" onClick={() => zbApiKeySaveMutation.mutate(zbApiKeyInput.trim() || null)} disabled={zbApiKeySaveMutation.isPending}><Save className="h-4 w-4 mr-1" />Save</Button>
                                    <Button variant="outline" size="sm" onClick={() => { setZbApiKeyEditing(false); setZbApiKeyInput(''); }}>Cancel</Button>
                                </>
                            ) : (
                                <>
                                    {zbApiKeyStatus?.configured ? (
                                        <code className="flex-1 bg-muted px-3 py-2.5 rounded text-sm font-mono">{zbApiKeyStatus.masked_key}</code>
                                    ) : (
                                        <span className="flex-1 text-sm text-muted-foreground italic">No API key configured</span>
                                    )}
                                    <Button variant="outline" size="sm" onClick={() => setZbApiKeyEditing(true)}>{zbApiKeyStatus?.configured ? 'Change' : 'Configure'}</Button>
                                    {zbApiKeyStatus?.configured && <Button variant="outline" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => zbApiKeySaveMutation.mutate(null)} disabled={zbApiKeySaveMutation.isPending}><Trash2 className="h-4 w-4" /></Button>}
                                </>
                            )}
                        </div>
                        {!zbApiKeyStatus?.configured && <p className="text-xs text-amber-600">Jobs sync and Zenbooker data import are disabled until an API key is configured.</p>}
                    </div>
                )}
            </div>

            <div className="flex items-center justify-between mb-4"><h2 className="text-lg font-semibold">API Keys</h2><Button onClick={() => setCreateOpen(true)} size="sm"><Plus className="h-4 w-4 mr-2" />Create Integration</Button></div>
            {isLoading ? <div className="text-center text-muted-foreground py-12">Loading…</div> : integrations.length === 0 ? (
                <div className="text-center py-12"><Key className="h-12 w-12 text-muted-foreground mx-auto mb-4" /><p className="text-muted-foreground">No integrations yet</p><p className="text-sm text-muted-foreground mt-1">Create your first integration to start accepting leads via API.</p></div>
            ) : (
                <div className="border rounded-lg overflow-hidden"><Table><TableHeader><TableRow className="bg-muted/50"><TableHead className="font-semibold">Client</TableHead><TableHead className="font-semibold">API Key</TableHead><TableHead className="font-semibold">Status</TableHead><TableHead className="font-semibold">Scopes</TableHead><TableHead className="font-semibold">Last Used</TableHead><TableHead className="font-semibold">Created</TableHead><TableHead className="font-semibold text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{integrations.map(integration => (
                    <TableRow key={integration.id}><TableCell className="font-medium">{integration.client_name}</TableCell><TableCell><code className="text-xs bg-muted px-2 py-1 rounded font-mono">{integration.key_id.slice(0, 12)}…</code><button onClick={() => copyToClipboard(integration.key_id, 'API Key')} className="ml-2 text-muted-foreground hover:text-foreground transition-colors" title="Copy full key"><Copy className="h-3.5 w-3.5 inline" /></button></TableCell><TableCell>{getStatusBadge(integration)}</TableCell><TableCell><div className="flex gap-1 flex-wrap">{(integration.scopes || []).map(scope => <Badge key={scope} variant="outline" className="text-xs">{scope}</Badge>)}</div></TableCell><TableCell className="text-sm text-muted-foreground">{formatDate(integration.last_used_at)}</TableCell><TableCell className="text-sm text-muted-foreground">{formatDate(integration.created_at)}</TableCell><TableCell className="text-right">{!integration.revoked_at && <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => setRevokeTarget(integration)}><ShieldOff className="h-4 w-4 mr-1" />Revoke</Button>}</TableCell></TableRow>
                ))}</TableBody></Table></div>
            )}

            <CreateDialog open={createOpen} onOpenChange={setCreateOpen} clientName={clientName} setClientName={setClientName} onSubmit={handleCreate} isPending={createMutation.isPending} />
            <SecretDialog open={secretModalOpen} onOpenChange={setSecretModalOpen} integration={newIntegration} />
            <RevokeDialog target={revokeTarget} onClose={() => setRevokeTarget(null)} onRevoke={() => revokeTarget && revokeMutation.mutate(revokeTarget.key_id)} isPending={revokeMutation.isPending} />
            <RegenerateDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} onRegenerate={() => regenerateMutation.mutate()} isPending={regenerateMutation.isPending} />
        </div>
    );
}

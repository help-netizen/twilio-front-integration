import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { fetchIntegrations, createIntegration, revokeIntegration, fetchWebhookUrl, regenerateWebhookUrl, fetchZenbookerApiKey, saveZenbookerApiKey, type Integration } from '../services/integrationsApi';
import { disconnectMarketplaceInstallation, fetchMarketplaceApps, installMarketplaceApp, retryMarketplaceProvisioning, type MarketplaceApp } from '../services/marketplaceApi';
import { getMailboxSettings } from '../services/emailApi';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/table';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Plus, Copy, ShieldOff, Key, Webhook, RefreshCw, Check, Settings2, Save, Trash2, Store, AlertCircle, ExternalLink } from 'lucide-react';
import { CreateDialog, SecretDialog, RevokeDialog, RegenerateDialog } from './IntegrationDialogs';
import { RelyLeadsSettingsDialog } from './RelyLeadsSettingsDialog';
import { RateMeSettingsDialog } from './RateMeSettingsDialog';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';

function formatDate(dateStr: string | null | undefined) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function marketplaceStatusBadge(app: MarketplaceApp) {
    const status = app.installation?.status;
    if (status === 'connected') return <Badge className="bg-[rgba(27,139,99,0.12)] text-[var(--blanc-success)] hover:bg-[rgba(27,139,99,0.12)]">Connected</Badge>;
    if (status === 'provisioning_failed') return <Badge className="bg-[rgba(178,106,29,0.12)] text-[var(--blanc-warning)] hover:bg-[rgba(178,106,29,0.12)]">Needs attention</Badge>;
    if (status === 'disconnected' || status === 'revoked') return <Badge variant="secondary">Disconnected</Badge>;
    return <Badge variant="outline">Available</Badge>;
}

function MarketplaceConnectDialog({
    app,
    open,
    onOpenChange,
    onConfirm,
    isPending,
    gmailConnected,
}: {
    app: MarketplaceApp | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    isPending: boolean;
    gmailConnected: boolean;
}) {
    const requiresGmail = !!app?.metadata?.requires_connected_gmail;
    const canConnect = !requiresGmail || gmailConnected;
    const settingsPath = app?.metadata?.dependency_cta?.path || '/settings/integrations/google-email';
    const accessItems = app
        ? (app.access_summary.length ? app.access_summary : app.requested_scopes)
        : [];
    const valueCopy = app?.app_key === 'smart-slot-engine'
        ? 'Help dispatchers choose the best arrival window and technician for every job, so scheduling is faster and routes make more sense.'
        : app?.app_key === 'ai-repair-advisor'
            ? 'Give technicians a practical head start with likely causes and diagnostic steps added to every new job.'
            : app?.short_description;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Enable {app?.name}</DialogTitle>
                    <DialogDescription>{valueCopy}</DialogDescription>
                </DialogHeader>
                {app && (
                    <div className="space-y-5 py-1">
                        <div className="space-y-2.5">
                            <div className="text-sm font-medium text-[var(--blanc-ink-1)]">What Albusto will do</div>
                            <ul className="space-y-2 pl-5 text-sm text-[var(--blanc-ink-2)] list-disc">
                                {accessItems.map((item) => (
                                    <li key={item}>{item}</li>
                                ))}
                            </ul>
                        </div>

                        {requiresGmail && (
                            <div className="space-y-1">
                                <div className="text-sm font-medium text-[var(--blanc-ink-1)]">Gmail connection</div>
                                <p className="text-sm text-[var(--blanc-ink-2)]">
                                    {gmailConnected
                                        ? 'Ready. This company has a connected Gmail mailbox.'
                                        : 'Connect Gmail before enabling Mail Secretary.'}
                                </p>
                            </div>
                        )}

                        {app.privacy_url && (
                            <a className="inline-flex items-center gap-1 text-sm text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]" href={app.privacy_url} target="_blank" rel="noreferrer">
                                Privacy details <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    {canConnect ? (
                        <Button onClick={onConfirm} disabled={isPending}>{isPending ? 'Enabling…' : `Enable ${app?.name}`}</Button>
                    ) : (
                        <Button onClick={() => { window.location.href = settingsPath; }}>
                            Connect Gmail
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function MarketplaceDisconnectDialog({
    app,
    open,
    onOpenChange,
    onConfirm,
    isPending,
}: {
    app: MarketplaceApp | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    isPending: boolean;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Disconnect {app?.name}</DialogTitle>
                    <DialogDescription>
                        Albusto will revoke this app's API credentials immediately. Data already stored in the provider's own system is not deleted by Albusto.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button variant="destructive" onClick={onConfirm} disabled={isPending}>{isPending ? 'Disconnecting…' : 'Disconnect'}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function IntegrationsPage() {
    const navigate = useNavigate();
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
    const [connectTarget, setConnectTarget] = useState<MarketplaceApp | null>(null);
    const [disconnectTarget, setDisconnectTarget] = useState<MarketplaceApp | null>(null);
    const [relySettingsOpen, setRelySettingsOpen] = useState(false);
    const [rateMeSettingsOpen, setRateMeSettingsOpen] = useState(false);

    const { data: apps = [], isLoading: marketplaceLoading } = useQuery({ queryKey: ['marketplace-apps'], queryFn: fetchMarketplaceApps });
    const { data: mailbox } = useQuery({ queryKey: ['email-mailbox-settings'], queryFn: getMailboxSettings });
    const { data: integrations = [], isLoading } = useQuery({ queryKey: ['integrations'], queryFn: fetchIntegrations });
    const { data: webhookData, isLoading: webhookLoading } = useQuery({ queryKey: ['zenbooker-webhook-url'], queryFn: fetchWebhookUrl });
    const { data: zbApiKeyStatus, isLoading: zbApiKeyLoading } = useQuery({ queryKey: ['zenbooker-api-key'], queryFn: fetchZenbookerApiKey });

    const invalidateMarketplace = () => queryClient.invalidateQueries({ queryKey: ['marketplace-apps'] });
    const installMutation = useMutation({
        mutationFn: installMarketplaceApp,
        onSuccess: () => { invalidateMarketplace(); setConnectTarget(null); toast.success('App connected'); },
        onError: (err: Error) => toast.error(err.message || 'Failed to connect app'),
    });
    const disconnectMutation = useMutation({
        mutationFn: disconnectMarketplaceInstallation,
        onSuccess: () => { invalidateMarketplace(); setDisconnectTarget(null); toast.success('App disconnected'); },
        onError: (err: Error) => toast.error(err.message || 'Failed to disconnect app'),
    });
    const retryMutation = useMutation({
        mutationFn: retryMarketplaceProvisioning,
        onSuccess: () => { invalidateMarketplace(); toast.success('Provisioning retried'); },
        onError: (err: Error) => toast.error(err.message || 'Failed to retry provisioning'),
    });

    const regenerateMutation = useMutation({ mutationFn: regenerateWebhookUrl, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['zenbooker-webhook-url'] }); setRegenerateOpen(false); toast.success('Webhook URL regenerated'); }, onError: () => toast.error('Failed to regenerate webhook URL') });
    const zbApiKeySaveMutation = useMutation({ mutationFn: (key: string | null) => saveZenbookerApiKey(key), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['zenbooker-api-key'] }); setZbApiKeyEditing(false); setZbApiKeyInput(''); toast.success('Zenbooker API key updated'); }, onError: () => toast.error('Failed to update Zenbooker API key') });
    const createMutation = useMutation({ mutationFn: createIntegration, onSuccess: (result) => { queryClient.invalidateQueries({ queryKey: ['integrations'] }); setNewIntegration(result); setCreateOpen(false); setSecretModalOpen(true); setClientName(''); toast.success('Integration created'); }, onError: () => toast.error('Failed to create integration') });
    const revokeMutation = useMutation({ mutationFn: revokeIntegration, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['integrations'] }); setRevokeTarget(null); toast.success('Integration revoked'); }, onError: () => toast.error('Failed to revoke integration') });

    function handleCreate() { if (!clientName.trim()) return; createMutation.mutate({ client_name: clientName.trim() }); }
    function copyToClipboard(text: string, label: string) { navigator.clipboard.writeText(text); toast.success(`${label} copied to clipboard`); }
    function copyWebhookUrl() { if (!webhookData?.url) return; navigator.clipboard.writeText(webhookData.url); setWebhookCopied(true); toast.success('Webhook URL copied to clipboard'); setTimeout(() => setWebhookCopied(false), 2000); }
    function getStatusBadge(integration: Integration) { if (integration.revoked_at) return <Badge variant="destructive">Revoked</Badge>; if (integration.expires_at && new Date(integration.expires_at) < new Date()) return <Badge variant="secondary">Expired</Badge>; return <Badge className="bg-[rgba(27,139,99,0.12)] text-[var(--blanc-success)] hover:bg-[rgba(27,139,99,0.12)]">Active</Badge>; }
    const gmailConnected = mailbox?.provider === 'gmail' && mailbox.status === 'connected';

    return (
        <SettingsPageShell
            title="Integrations"
            description="Connect apps, manage API credentials, and configure external services"
        >
            <Tabs defaultValue="marketplace" className="space-y-6">
                <TabsList>
                    <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
                    <TabsTrigger value="api-keys">API Keys</TabsTrigger>
                    <TabsTrigger value="zenbooker">Zenbooker</TabsTrigger>
                </TabsList>

                <TabsContent value="marketplace" className="mt-0">
                    {marketplaceLoading ? (
                        <div className="text-center text-[var(--blanc-ink-2)] py-12">Loading apps…</div>
                    ) : apps.length === 0 ? (
                        <div className="text-center py-12 border border-[var(--blanc-line)] rounded-xl">
                            <Store className="h-12 w-12 text-[var(--blanc-ink-3)] mx-auto mb-4" />
                            <p className="text-[var(--blanc-ink-2)]">No marketplace apps are published yet</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            {apps.map(app => (
                                <div key={app.app_key} className="flex min-h-[230px] flex-col rounded-xl border border-[var(--blanc-line)] bg-[var(--blanc-surface-strong)] p-5">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0">
                                            <h2 className="text-lg font-semibold truncate text-[var(--blanc-ink-1)]">{app.name}</h2>
                                            <p className="text-sm text-[var(--blanc-ink-2)] mt-1">{app.provider_name} · {app.category.replace(/_/g, ' ')}</p>
                                        </div>
                                        {marketplaceStatusBadge(app)}
                                    </div>

                                    <p className="mt-4 text-sm text-[var(--blanc-ink-1)]">{app.short_description}</p>

                                    <div className="mt-4">
                                        <div className="text-xs font-medium text-[var(--blanc-ink-3)] mb-2">Access</div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {(app.access_summary.length ? app.access_summary : app.requested_scopes).map(item => (
                                                <Badge key={item} variant="outline" className="h-auto max-w-full whitespace-normal text-left text-xs leading-5">{item}</Badge>
                                            ))}
                                        </div>
                                    </div>

                                    {app.metadata?.requires_connected_gmail && !gmailConnected && !app.installation && (
                                        <p className="mt-4 text-sm text-[var(--blanc-ink-2)]">
                                            Connect Gmail before enabling this app.
                                        </p>
                                    )}

                                    {app.installation?.provisioning_error && (
                                        <p className="mt-4 flex items-start gap-2 text-sm text-[var(--blanc-warning)]">
                                            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                            <span>{app.installation.provisioning_error}</span>
                                        </p>
                                    )}

                                    <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                                        <div className="text-xs text-[var(--blanc-ink-3)]">
                                            {app.installation?.status === 'connected' ? `Last used ${formatDate(app.installation.last_used_at)}` : `Mode: ${app.provisioning_mode.replace(/_/g, ' ')}`}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {app.app_key === 'vapi-ai' ? (
                                                <Button
                                                    size="sm"
                                                    variant={app.installation?.status === 'connected' ? 'outline' : 'default'}
                                                    onClick={() => navigate('/settings/integrations/vapi-ai')}
                                                >
                                                    {app.installation?.status === 'connected' ? 'Manage' : 'Configure'}
                                                </Button>
                                            ) : app.app_key === 'stripe-payments' ? (
                                                <Button
                                                    size="sm"
                                                    variant={app.installation?.status === 'connected' ? 'outline' : 'default'}
                                                    onClick={() => navigate('/settings/integrations/stripe-payments')}
                                                >
                                                    {app.installation?.status === 'connected' || app.installation?.status === 'provisioning_failed' ? 'Manage' : 'Configure'}
                                                </Button>
                                            ) : app.app_key === 'google-email' ? (
                                                <Button
                                                    size="sm"
                                                    variant={gmailConnected ? 'outline' : 'default'}
                                                    onClick={() => navigate(String(app.metadata?.setup_path || '/settings/integrations/google-email'))}
                                                >
                                                    {gmailConnected ? 'Manage' : 'Connect'}
                                                </Button>
                                            ) : app.app_key === 'telephony-twilio' ? (
                                                // ONBTEL-001 §2.2: derived connection state — the generic
                                                // Enable/MarketplaceConnectDialog path is unreachable here.
                                                <Button
                                                    size="sm"
                                                    variant={app.installation?.status === 'connected' ? 'outline' : 'default'}
                                                    onClick={() => navigate(
                                                        app.installation?.status === 'connected'
                                                            ? '/settings/telephony'
                                                            : String(app.metadata?.setup_path || '/settings/integrations/telephony-twilio')
                                                    )}
                                                >
                                                    {app.installation?.status === 'connected' ? 'Manage' : 'Configure'}
                                                </Button>
                                            ) : (
                                                <>
                                                    {app.installation?.status === 'provisioning_failed' && (
                                                        <Button variant="outline" size="sm" onClick={() => retryMutation.mutate(app.installation!.id)} disabled={retryMutation.isPending}>
                                                            Retry
                                                        </Button>
                                                    )}
                                                    {app.installation?.status === 'connected' && app.metadata?.setup_path && (
                                                        <Button size="sm" onClick={() => navigate(String(app.metadata!.setup_path))}>
                                                            Setup
                                                        </Button>
                                                    )}
                                                    {app.app_key === 'rely-leads' && app.installation?.status === 'connected' && (
                                                        <Button variant="outline" size="sm" onClick={() => setRelySettingsOpen(true)}>
                                                            Settings
                                                        </Button>
                                                    )}
                                                    {app.app_key === 'rate-me' && app.installation?.status === 'connected' && (
                                                        <Button variant="outline" size="sm" onClick={() => setRateMeSettingsOpen(true)}>
                                                            Settings
                                                        </Button>
                                                    )}
                                                    {app.installation?.status === 'connected' || app.installation?.status === 'provisioning_failed' ? (
                                                        <Button variant="outline" size="sm" onClick={() => setDisconnectTarget(app)}>
                                                            Disconnect
                                                        </Button>
                                                    ) : (
                                                        <Button size="sm" onClick={() => setConnectTarget(app)}>
                                                            Enable
                                                        </Button>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </TabsContent>

                <TabsContent value="api-keys" className="mt-0">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h2 className="text-lg font-semibold text-[var(--blanc-ink-1)]">Manual API Keys</h2>
                            <p className="text-sm text-[var(--blanc-ink-2)] mt-1">Credentials for custom/private integrations. Marketplace apps use hidden credentials.</p>
                        </div>
                        <Button onClick={() => setCreateOpen(true)} size="sm"><Plus className="h-4 w-4 mr-2" />Create Integration</Button>
                    </div>
                    {isLoading ? <div className="text-center text-[var(--blanc-ink-2)] py-12">Loading…</div> : integrations.length === 0 ? (
                        <div className="text-center py-12 border border-[var(--blanc-line)] rounded-xl"><Key className="h-12 w-12 text-[var(--blanc-ink-3)] mx-auto mb-4" /><p className="text-[var(--blanc-ink-2)]">No integrations yet</p><p className="text-sm text-[var(--blanc-ink-3)] mt-1">Create your first manual integration to start accepting leads via API.</p></div>
                    ) : (
                        <div className="border border-[var(--blanc-line)] rounded-xl overflow-hidden"><Table><TableHeader><TableRow className="bg-[rgba(25,25,25,0.03)]"><TableHead className="font-semibold">Client</TableHead><TableHead className="font-semibold">API Key</TableHead><TableHead className="font-semibold">Status</TableHead><TableHead className="font-semibold">Scopes</TableHead><TableHead className="font-semibold">Last Used</TableHead><TableHead className="font-semibold">Created</TableHead><TableHead className="font-semibold text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{integrations.map(integration => (
                            <TableRow key={integration.id}><TableCell className="font-medium">{integration.client_name}</TableCell><TableCell><code className="text-xs bg-[rgba(25,25,25,0.03)] px-2 py-1 rounded font-mono">{integration.key_id.slice(0, 12)}…</code><button onClick={() => copyToClipboard(integration.key_id, 'API Key')} className="ml-2 text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)] transition-colors" title="Copy full key"><Copy className="h-3.5 w-3.5 inline" /></button></TableCell><TableCell>{getStatusBadge(integration)}</TableCell><TableCell><div className="flex gap-1 flex-wrap">{(integration.scopes || []).map(scope => <Badge key={scope} variant="outline" className="text-xs">{scope}</Badge>)}</div></TableCell><TableCell className="text-sm text-[var(--blanc-ink-2)]">{formatDate(integration.last_used_at)}</TableCell><TableCell className="text-sm text-[var(--blanc-ink-2)]">{formatDate(integration.created_at)}</TableCell><TableCell className="text-right">{!integration.revoked_at && <Button variant="ghost" size="sm" className="text-[var(--blanc-danger)] hover:text-[var(--blanc-danger)] hover:bg-[rgba(212,77,60,0.08)]" onClick={() => setRevokeTarget(integration)}><ShieldOff className="h-4 w-4 mr-1" />Revoke</Button>}</TableCell></TableRow>
                        ))}</TableBody></Table></div>
                    )}
                </TabsContent>

                <TabsContent value="zenbooker" className="mt-0 space-y-6">
                    <div className="border border-[var(--blanc-line)] rounded-xl p-5 bg-[var(--blanc-surface-strong)]">
                        <div className="flex items-center gap-2 mb-1"><Webhook className="h-5 w-5 text-[var(--blanc-job)]" /><h2 className="text-lg font-semibold text-[var(--blanc-ink-1)]">Zenbooker Webhooks</h2></div>
                        <p className="text-sm text-[var(--blanc-ink-2)] mb-4">Paste this URL into Zenbooker → Settings → Webhooks for all event types you want to receive.</p>
                        {webhookLoading ? <div className="text-sm text-[var(--blanc-ink-2)]">Loading webhook URL…</div> : webhookData?.url ? (
                            <div className="space-y-3"><div className="flex items-center gap-2"><code className="flex-1 bg-[rgba(25,25,25,0.03)] px-3 py-2.5 rounded text-sm font-mono break-all select-all">{webhookData.url}</code><Button variant="outline" size="sm" onClick={copyWebhookUrl} className="shrink-0">{webhookCopied ? <Check className="h-4 w-4 text-[var(--blanc-success)]" /> : <Copy className="h-4 w-4" />}</Button><Button variant="outline" size="sm" onClick={() => setRegenerateOpen(true)} className="shrink-0" title="Generate new URL (invalidates old one)"><RefreshCw className="h-4 w-4" /></Button></div><p className="text-xs text-[var(--blanc-ink-3)]">This URL works for all webhook event types: jobs, customers, invoices, etc.</p></div>
                        ) : <div className="text-sm text-[var(--blanc-danger)]">Failed to load webhook URL</div>}
                    </div>

                    <div className="border border-[var(--blanc-line)] rounded-xl p-5 bg-[var(--blanc-surface-strong)]">
                        <div className="flex items-center gap-2 mb-1"><Settings2 className="h-5 w-5 text-[var(--blanc-warning)]" /><h2 className="text-lg font-semibold text-[var(--blanc-ink-1)]">Zenbooker API Key</h2></div>
                        <p className="text-sm text-[var(--blanc-ink-2)] mb-4">Configure your Zenbooker API key to enable jobs sync and customer data import for this company.</p>
                        {zbApiKeyLoading ? <div className="text-sm text-[var(--blanc-ink-2)]">Loading...</div> : (
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
                                                <code className="flex-1 bg-[rgba(25,25,25,0.03)] px-3 py-2.5 rounded text-sm font-mono">{zbApiKeyStatus.masked_key}</code>
                                            ) : (
                                                <span className="flex-1 text-sm text-[var(--blanc-ink-3)] italic">No API key configured</span>
                                            )}
                                            <Button variant="outline" size="sm" onClick={() => setZbApiKeyEditing(true)}>{zbApiKeyStatus?.configured ? 'Change' : 'Configure'}</Button>
                                            {zbApiKeyStatus?.configured && <Button variant="outline" size="sm" className="text-[var(--blanc-danger)] hover:text-[var(--blanc-danger)] hover:bg-[rgba(212,77,60,0.08)]" onClick={() => zbApiKeySaveMutation.mutate(null)} disabled={zbApiKeySaveMutation.isPending}><Trash2 className="h-4 w-4" /></Button>}
                                        </>
                                    )}
                                </div>
                                {!zbApiKeyStatus?.configured && <p className="text-xs text-[var(--blanc-warning)]">Jobs sync and Zenbooker data import are disabled until an API key is configured.</p>}
                            </div>
                        )}
                    </div>
                </TabsContent>
            </Tabs>

            <MarketplaceConnectDialog
                app={connectTarget}
                open={!!connectTarget}
                onOpenChange={open => !open && setConnectTarget(null)}
                onConfirm={() => connectTarget && installMutation.mutate(connectTarget.app_key)}
                isPending={installMutation.isPending}
                gmailConnected={gmailConnected}
            />
            <MarketplaceDisconnectDialog
                app={disconnectTarget}
                open={!!disconnectTarget}
                onOpenChange={open => !open && setDisconnectTarget(null)}
                onConfirm={() => disconnectTarget?.installation && disconnectMutation.mutate(disconnectTarget.installation.id)}
                isPending={disconnectMutation.isPending}
            />
            <RelyLeadsSettingsDialog open={relySettingsOpen} onOpenChange={setRelySettingsOpen} />
            <RateMeSettingsDialog open={rateMeSettingsOpen} onOpenChange={setRateMeSettingsOpen} />
            <CreateDialog open={createOpen} onOpenChange={setCreateOpen} clientName={clientName} setClientName={setClientName} onSubmit={handleCreate} isPending={createMutation.isPending} />
            <SecretDialog open={secretModalOpen} onOpenChange={setSecretModalOpen} integration={newIntegration} />
            <RevokeDialog target={revokeTarget} onClose={() => setRevokeTarget(null)} onRevoke={() => revokeTarget && revokeMutation.mutate(revokeTarget.key_id)} isPending={revokeMutation.isPending} />
            <RegenerateDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} onRegenerate={() => regenerateMutation.mutate()} isPending={regenerateMutation.isPending} />
        </SettingsPageShell>
    );
}

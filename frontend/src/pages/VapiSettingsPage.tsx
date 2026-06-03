import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, AlertCircle, Loader2, Eye, EyeOff, Bot, Unplug } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../components/ui/dialog';
import { vapiApi, type VapiConnection, type VapiResource } from '../services/vapiApi';
import { fetchMarketplaceApps, installMarketplaceApp, disconnectMarketplaceInstallation } from '../services/marketplaceApi';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const label = (text: string) => (
    <div className="blanc-eyebrow mb-1.5" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--blanc-ink-3)' }}>
        {text}
    </div>
);

const sectionCard = { background: 'rgba(117,106,89,0.04)', borderRadius: 16, padding: '20px 22px', marginBottom: 16 } as const;

const fieldStyle = {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid var(--blanc-line, rgba(117,106,89,0.18))',
    borderRadius: 10,
    fontSize: 13,
    background: 'var(--blanc-bg, #fffdf9)',
    color: 'var(--blanc-ink-1, #2c2620)',
    outline: 'none',
    fontFamily: 'IBM Plex Sans, sans-serif',
} as const;

// ─── Section: API Connection ──────────────────────────────────────────────────

function ConnectionSection({
    connection,
    onConnected,
}: {
    connection: VapiConnection | null;
    onConnected: (c: VapiConnection) => void;
}) {
    const [apiKey, setApiKey] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [environment, setEnvironment] = useState<'prod' | 'dev'>('prod');
    const [showKey, setShowKey] = useState(false);
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: () => vapiApi.createConnection({ api_key: apiKey.trim(), display_name: displayName.trim() || undefined, environment }),
        onSuccess: (data) => {
            setError('');
            onConnected(data);
            toast.success('API key verified');
        },
        onError: (err: Error) => {
            setError(err.message || 'Could not verify API key. Check the key and try again.');
        },
    });

    if (connection && connection.status === 'active') {
        return (
            <div style={sectionCard}>
                {label('API Connection')}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <CheckCircle2 size={16} style={{ color: '#22c55e', flexShrink: 0 }} />
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--blanc-ink-1)' }}>
                            {connection.display_name || 'VAPI Connection'}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--blanc-ink-2)' }}>••••••••••••••••</span>
                            <Badge variant="outline" style={{ fontSize: 10 }}>{connection.environment}</Badge>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={sectionCard}>
            {label('API Connection')}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blanc-ink-2)', marginBottom: 6 }}>VAPI API Key</div>
                    <div style={{ position: 'relative' }}>
                        <input
                            type={showKey ? 'text' : 'password'}
                            value={apiKey}
                            onChange={e => { setApiKey(e.target.value); setError(''); }}
                            placeholder="vapi-key-…"
                            style={{ ...fieldStyle, paddingRight: 40 }}
                            autoComplete="off"
                        />
                        <button
                            type="button"
                            onClick={() => setShowKey(v => !v)}
                            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3)', padding: 0 }}
                            tabIndex={-1}
                        >
                            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                    </div>
                    {error && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: '#ef4444' }}>
                            <AlertCircle size={12} />
                            {error}
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blanc-ink-2)', marginBottom: 6 }}>Display Name</div>
                        <input
                            type="text"
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            placeholder="My VAPI Prod"
                            style={fieldStyle}
                        />
                    </div>
                    <div style={{ width: 120 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blanc-ink-2)', marginBottom: 6 }}>Environment</div>
                        <select
                            value={environment}
                            onChange={e => setEnvironment(e.target.value as 'prod' | 'dev')}
                            style={fieldStyle}
                        >
                            <option value="prod">Production</option>
                            <option value="dev">Development</option>
                        </select>
                    </div>
                </div>

                <Button
                    onClick={() => mutation.mutate()}
                    disabled={!apiKey.trim() || mutation.isPending}
                    size="sm"
                    style={{ alignSelf: 'flex-start' }}
                >
                    {mutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                    Verify & Connect
                </Button>
            </div>
        </div>
    );
}

// ─── Section: SIP Resource ────────────────────────────────────────────────────

function ResourceSection({
    connectionId,
    resource,
    onSaved,
}: {
    connectionId: string;
    resource: VapiResource | null;
    onSaved: (r: VapiResource) => void;
}) {
    const [sipUri, setSipUri] = useState('');
    const [serverUrl, setServerUrl] = useState('');
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: () => vapiApi.createResource({ provider_connection_id: connectionId, sip_uri: sipUri.trim(), server_url: serverUrl.trim() || undefined }),
        onSuccess: (data) => {
            setError('');
            onSaved(data);
            toast.success('SIP resource saved');
        },
        onError: (err: Error) => {
            setError(err.message || 'Failed to save SIP resource.');
        },
    });

    if (resource) {
        return (
            <div style={sectionCard}>
                {label('SIP Resource')}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                        <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', marginBottom: 3 }}>SIP URI</div>
                        <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--blanc-ink-1)', padding: '6px 10px', background: 'rgba(117,106,89,0.06)', borderRadius: 8 }}>
                            {resource.sip_uri}
                        </div>
                    </div>
                    {resource.server_url && (
                        <div>
                            <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', marginBottom: 3 }}>Server URL</div>
                            <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--blanc-ink-1)', padding: '6px 10px', background: 'rgba(117,106,89,0.06)', borderRadius: 8, wordBreak: 'break-all' }}>
                                {resource.server_url}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div style={sectionCard}>
            {label('SIP Resource')}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blanc-ink-2)', marginBottom: 6 }}>SIP URI</div>
                    <input
                        type="text"
                        value={sipUri}
                        onChange={e => { setSipUri(e.target.value); setError(''); }}
                        placeholder="sip:tenant-abc@sip.vapi.ai"
                        style={fieldStyle}
                    />
                </div>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blanc-ink-2)', marginBottom: 6 }}>Server URL</div>
                    <input
                        type="text"
                        value={serverUrl}
                        onChange={e => setServerUrl(e.target.value)}
                        placeholder="https://your-domain.fly.dev/api/vapi/runtime"
                        style={fieldStyle}
                    />
                </div>
                {error && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444' }}>
                        <AlertCircle size={12} />
                        {error}
                    </div>
                )}
                <Button
                    onClick={() => mutation.mutate()}
                    disabled={!sipUri.trim() || mutation.isPending}
                    size="sm"
                    style={{ alignSelf: 'flex-start' }}
                >
                    {mutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                    Save SIP Resource
                </Button>
            </div>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VapiSettingsPage() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [localConnection, setLocalConnection] = useState<VapiConnection | null>(null);
    const [localResource, setLocalResource] = useState<VapiResource | null>(null);
    const [disconnectOpen, setDisconnectOpen] = useState(false);

    const { data: connections = [], isLoading: connLoading } = useQuery({
        queryKey: ['vapi-connections'],
        queryFn: vapiApi.getConnections,
    });

    const { data: resources = [], isLoading: resLoading } = useQuery({
        queryKey: ['vapi-resources'],
        queryFn: vapiApi.getResources,
    });

    const { data: apps = [] } = useQuery({
        queryKey: ['marketplace-apps'],
        queryFn: fetchMarketplaceApps,
    });

    const isLoading = connLoading || resLoading;

    const activeConnection = localConnection ?? connections.find(c => c.status === 'active') ?? null;
    const activeResource = localResource ?? resources.find(r => r.is_active) ?? null;
    const vapiApp = apps.find(a => a.app_key === 'vapi-ai');
    const activeInstallation = vapiApp?.installation?.status === 'connected' ? vapiApp.installation : null;

    const isFullyConnected = !!(activeConnection && activeResource && activeInstallation);

    const installMutation = useMutation({
        mutationFn: () => installMarketplaceApp('vapi-ai'),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['marketplace-apps'] });
            toast.success('VAPI AI connected');
            navigate('/settings/integrations');
        },
        onError: (err: Error) => {
            if (err.message?.includes('ALREADY_INSTALLED')) {
                queryClient.invalidateQueries({ queryKey: ['marketplace-apps'] });
                navigate('/settings/integrations');
            } else {
                toast.error(err.message || 'Failed to finish setup');
            }
        },
    });

    const disconnectMutation = useMutation({
        mutationFn: () => disconnectMarketplaceInstallation(vapiApp!.installation!.id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['marketplace-apps'] });
            toast.success('VAPI AI disconnected');
            navigate('/settings/integrations');
        },
        onError: () => toast.error('Failed to disconnect VAPI AI'),
    });

    if (isLoading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
                <Loader2 size={20} style={{ color: 'var(--blanc-ink-3)' }} className="animate-spin" />
            </div>
        );
    }

    return (
        <div style={{ maxWidth: 580, margin: '0 auto', padding: '32px 24px' }}>
            {/* Header */}
            <button
                onClick={() => navigate('/settings/integrations')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3)', fontSize: 13, marginBottom: 24, padding: 0 }}
            >
                <ArrowLeft size={14} />
                Back to Integrations
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(124,58,237,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Bot size={22} style={{ color: '#7c3aed' }} />
                </div>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Manrope, sans-serif', color: 'var(--blanc-ink-1)', margin: 0 }}>
                        VAPI AI
                    </h1>
                    <div style={{ fontSize: 13, color: 'var(--blanc-ink-3)', marginTop: 2 }}>
                        Route inbound calls to an AI voice agent
                    </div>
                </div>
                {isFullyConnected && (
                    <Badge className="ml-auto" style={{ background: 'rgba(34,197,94,0.1)', color: '#16a34a', border: 'none', fontSize: 12 }}>
                        Connected
                    </Badge>
                )}
            </div>

            {/* Setup / View sections */}
            <ConnectionSection
                connection={activeConnection}
                onConnected={setLocalConnection}
            />

            {activeConnection && (
                <ResourceSection
                    connectionId={activeConnection.id}
                    resource={activeResource}
                    onSaved={setLocalResource}
                />
            )}

            {/* Finish Setup */}
            {activeConnection && activeResource && !activeInstallation && (
                <div style={{ marginTop: 8 }}>
                    <Button
                        onClick={() => installMutation.mutate()}
                        disabled={installMutation.isPending}
                        style={{ width: '100%' }}
                    >
                        {installMutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                        Finish Setup
                    </Button>
                    <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', textAlign: 'center', marginTop: 8 }}>
                        After finishing, the VAPI AI node will be available in your Call Flow Builder.
                    </div>
                </div>
            )}

            {/* Disconnect */}
            {isFullyConnected && (
                <div style={{ marginTop: 24 }}>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDisconnectOpen(true)}
                        style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}
                    >
                        <Unplug size={13} className="mr-1.5" />
                        Disconnect VAPI AI
                    </Button>
                </div>
            )}

            {/* Disconnect confirm */}
            <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Disconnect VAPI AI?</DialogTitle>
                        <DialogDescription>
                            Routing to VAPI AI nodes in your call flows will stop working. Your API key and SIP configuration will be retained.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDisconnectOpen(false)}>Cancel</Button>
                        <Button
                            variant="destructive"
                            onClick={() => disconnectMutation.mutate()}
                            disabled={disconnectMutation.isPending}
                        >
                            {disconnectMutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                            Disconnect
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, AlertCircle, Loader2, Eye, EyeOff, Unplug, PhoneCall, Clock3, Workflow } from 'lucide-react';
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
import { FloatingField } from '../components/ui/floating-field';
import { FloatingSelect } from '../components/ui/floating-select';
import { SelectItem } from '../components/ui/select';
import { CloudBanner } from '../components/ui/CloudBanner';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import { vapiApi, type VapiConnection, type VapiResource } from '../services/vapiApi';
import { fetchMarketplaceApps, installMarketplaceApp, disconnectMarketplaceInstallation } from '../services/marketplaceApi';

const VAPI_DISPLAY_NAME = 'VAPI AI';

// ─── Section: API Connection ──────────────────────────────────────────────────

function ConnectionSection({
    connection,
    onConnected,
}: {
    connection: VapiConnection | null;
    onConnected: (c: VapiConnection) => void;
}) {
    const [apiKey, setApiKey] = useState('');
    const [environment, setEnvironment] = useState<'prod' | 'dev'>('prod');
    const [showKey, setShowKey] = useState(false);
    const [error, setError] = useState('');

    const mutation = useMutation({
        mutationFn: () => vapiApi.createConnection({ api_key: apiKey.trim(), display_name: VAPI_DISPLAY_NAME, environment }),
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
            <SettingsSection
                title="Voice agent connection"
                description="Your VAPI workspace is securely connected to Albusto."
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <CheckCircle2 size={16} style={{ color: 'var(--blanc-success)', flexShrink: 0 }} />
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--blanc-ink-1)' }}>
                            {VAPI_DISPLAY_NAME}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--blanc-ink-2)' }}>••••••••••••••••</span>
                            <Badge variant="outline" style={{ fontSize: 10 }}>{connection.environment}</Badge>
                        </div>
                    </div>
                </div>
            </SettingsSection>
        );
    }

    return (
        <CloudBanner variant="hero">
            <p className="blanc-eyebrow">VOICE AI</p>
            <h3
                className="mt-2 text-2xl sm:text-[28px]"
                style={{ fontFamily: 'var(--blanc-font-heading)', fontWeight: 800, color: 'var(--blanc-ink-1)' }}
            >
                Never let a call go unanswered
            </h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                Give every caller a helpful first response, even when your team is busy or the office is closed.
            </p>
            <div className="mt-4 space-y-2.5">
                <div className="flex items-start gap-2.5">
                    <PhoneCall className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                    <p className="text-sm">
                        <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Answer around the clock</span>
                        <span style={{ color: 'var(--blanc-ink-2)' }}> — Your AI voice agent is ready when customers call</span>
                    </p>
                </div>
                <div className="flex items-start gap-2.5">
                    <Clock3 className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                    <p className="text-sm">
                        <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Keep callers moving</span>
                        <span style={{ color: 'var(--blanc-ink-2)' }}> — Handle routine questions and gather the details your team needs</span>
                    </p>
                </div>
                <div className="flex items-start gap-2.5">
                    <Workflow className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-accent)' }} />
                    <p className="text-sm">
                        <span className="font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Fit your call flow</span>
                        <span style={{ color: 'var(--blanc-ink-2)' }}> — Route callers to VAPI exactly where a voice agent helps most</span>
                    </p>
                </div>
            </div>
            <div className="mt-5 space-y-3.5">
                <div>
                    <div style={{ position: 'relative' }}>
                        <FloatingField
                            label="VAPI API Key"
                            id="vapi-api-key"
                            type={showKey ? 'text' : 'password'}
                            value={apiKey}
                            onChange={e => { setApiKey(e.target.value); setError(''); }}
                            className="pr-10"
                        />
                        <button
                            type="button"
                            onClick={() => setShowKey(v => !v)}
                            style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3)', padding: 0 }}
                            tabIndex={-1}
                        >
                            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                    </div>
                    {error && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--blanc-danger)' }}>
                            <AlertCircle size={12} />
                            {error}
                        </div>
                    )}
                </div>

                <div style={{ width: 200 }}>
                    <FloatingSelect
                        label="Environment"
                        id="vapi-environment"
                        value={environment}
                        onValueChange={v => setEnvironment(v as 'prod' | 'dev')}
                    >
                        <SelectItem value="prod">Production</SelectItem>
                        <SelectItem value="dev">Development</SelectItem>
                    </FloatingSelect>
                </div>
            </div>
            <Button
                className="mt-5 h-11 px-6"
                onClick={() => mutation.mutate()}
                disabled={!apiKey.trim() || mutation.isPending}
            >
                {mutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                Connect VAPI
            </Button>
            <p className="mt-2.5 text-[13px]" style={{ color: 'var(--blanc-ink-3)' }}>
                Takes about 5 minutes. Have your VAPI API key and SIP URI handy.
            </p>
        </CloudBanner>
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
            <SettingsSection
                title="Call routing"
                description="Albusto sends calls to this VAPI destination."
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                        <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', marginBottom: 3 }}>SIP URI</div>
                        <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--blanc-ink-1)', padding: '6px 10px', background: 'rgba(25,25,25,0.06)', borderRadius: 8 }}>
                            {resource.sip_uri}
                        </div>
                    </div>
                    {resource.server_url && (
                        <div>
                            <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', marginBottom: 3 }}>Server URL</div>
                            <div style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--blanc-ink-1)', padding: '6px 10px', background: 'rgba(25,25,25,0.06)', borderRadius: 8, wordBreak: 'break-all' }}>
                                {resource.server_url}
                            </div>
                        </div>
                    )}
                </div>
            </SettingsSection>
        );
    }

    return (
        <SettingsSection
            title="Call routing"
            description="Tell Albusto where to send calls for your VAPI voice agent."
            footer={
                <Button
                    onClick={() => mutation.mutate()}
                    disabled={!sipUri.trim() || mutation.isPending}
                    size="sm"
                >
                    {mutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                    Save call routing
                </Button>
            }
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <FloatingField
                    label="SIP URI"
                    id="vapi-sip-uri"
                    value={sipUri}
                    onChange={e => { setSipUri(e.target.value); setError(''); }}
                />
                <FloatingField
                    label="Server URL"
                    id="vapi-server-url"
                    value={serverUrl}
                    onChange={e => setServerUrl(e.target.value)}
                />
                {error && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--blanc-danger)' }}>
                        <AlertCircle size={12} />
                        {error}
                    </div>
                )}
            </div>
        </SettingsSection>
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

    return (
        <SettingsPageShell
            backTo="/settings/integrations"
            backLabel="Back to Integrations"
            title="VAPI AI"
            description="Let an AI voice agent answer calls and pass the right context to your team."
            actions={isFullyConnected ? (
                <Badge className="bg-[rgba(27,139,99,0.12)] text-[var(--blanc-success)]" style={{ border: 'none', fontSize: 12 }}>
                    Connected
                </Badge>
            ) : undefined}
        >
            {isLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
                    <Loader2 size={20} style={{ color: 'var(--blanc-ink-3)' }} className="animate-spin" />
                </div>
            ) : (
                <>
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

                    {/* Finish Setup — natural-width button, aligned under the card column
                        (empty left cell mirrors SettingsSection's label/card grid). */}
                    {activeConnection && activeResource && !activeInstallation && (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[240px_1fr] md:gap-8">
                            <div className="hidden md:block" />
                            <div>
                                <Button
                                    onClick={() => installMutation.mutate()}
                                    disabled={installMutation.isPending}
                                >
                                    {installMutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                                    Finish setup
                                </Button>
                                <div style={{ fontSize: 11, color: 'var(--blanc-ink-3)', marginTop: 8 }}>
                                    Once enabled, you can add your VAPI voice agent anywhere in the Call Flow Builder.
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Disconnect — same column alignment as the section cards above. */}
                    {isFullyConnected && (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[240px_1fr] md:gap-8">
                            <div className="hidden md:block" />
                            <div>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => setDisconnectOpen(true)}
                                >
                                    <Unplug size={13} className="mr-1.5" />
                                    Disconnect VAPI AI
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Disconnect confirm */}
            <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Disconnect VAPI AI?</DialogTitle>
                        <DialogDescription>
                            Your call flows will stop routing callers to the voice agent. Your API key and call routing details will stay saved for next time.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDisconnectOpen(false)}>Cancel</Button>
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
        </SettingsPageShell>
    );
}

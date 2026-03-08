import { useState, useEffect } from 'react';
import { Shield, CheckCircle, AlertCircle, RefreshCw, Copy, Wifi, Key, Server, Globe, Terminal } from 'lucide-react';
import { extendedMockApi, type ProviderInfo } from '../../services/extendedMockApi';

export default function ProviderSettingsPage() {
    const [provider, setProvider] = useState<ProviderInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('overview');

    useEffect(() => { extendedMockApi.getProviderInfo().then(p => { setProvider(p); setLoading(false); }); }, []);

    if (loading || !provider) return <div style={{ padding: 32 }}><div style={{ width: 24, height: 24, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    const tabs = [
        { key: 'overview', label: 'Overview', icon: <Server size={14} /> },
        { key: 'credentials', label: 'Credentials', icon: <Key size={14} /> },
        { key: 'webhooks', label: 'Webhooks', icon: <Globe size={14} /> },
        { key: 'numbers', label: 'Number Sync', icon: <Wifi size={14} /> },
        { key: 'cli', label: 'CLI Reference', icon: <Terminal size={14} /> },
    ];

    const healthColor = provider.connection_health === 'healthy' ? '#10b981' : provider.connection_health === 'degraded' ? '#f59e0b' : '#ef4444';

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1000 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Shield size={22} style={{ color: '#ef4444' }} /></div>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111', margin: 0 }}>Provider Settings</h1>
                    <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>Advanced: Telephony provider configuration and diagnostics</p>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: healthColor }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: healthColor, textTransform: 'capitalize' }}>{provider.connection_health}</span>
                </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 2, marginBottom: 24, borderBottom: '1px solid #e5e7eb' }}>
                {tabs.map(t => (
                    <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', fontSize: 13, fontWeight: activeTab === t.key ? 600 : 400, color: activeTab === t.key ? '#6366f1' : '#6b7280', background: 'none', border: 'none', borderBottom: activeTab === t.key ? '2px solid #6366f1' : '2px solid transparent', cursor: 'pointer', marginBottom: -1 }}>
                        {t.icon}{t.label}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24 }}>
                {activeTab === 'overview' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {[
                            { label: 'Provider', value: provider.name },
                            { label: 'Connection Status', value: provider.status, badge: true, color: provider.status === 'connected' ? '#10b981' : '#ef4444' },
                            { label: 'Connection Health', value: provider.connection_health, badge: true, color: healthColor },
                            { label: 'Last Webhook', value: provider.last_webhook_received ? new Date(provider.last_webhook_received).toLocaleString() : '—' },
                            { label: 'Last Sync', value: provider.last_sync ? new Date(provider.last_sync).toLocaleString() : '—' },
                            { label: 'Numbers Synced', value: String(provider.numbers_synced) },
                        ].map(r => (
                            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                                <span style={{ fontSize: 13, color: '#6b7280' }}>{r.label}</span>
                                {r.badge ? <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 10, background: `${r.color}15`, color: r.color, textTransform: 'capitalize' }}>{r.value}</span> :
                                    <span style={{ fontSize: 13, fontWeight: 500 }}>{r.value}</span>}
                            </div>
                        ))}
                        {provider.last_errors.length > 0 && (
                            <div style={{ marginTop: 8 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, color: '#991b1b', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}><AlertCircle size={14} />Recent Errors</div>
                                {provider.last_errors.map((e, i) => (
                                    <div key={i} style={{ fontSize: 12, color: '#991b1b', padding: '6px 10px', background: '#fef2f2', borderRadius: 6, marginBottom: 4 }}>
                                        <span>{e.message}</span>
                                        <span style={{ marginLeft: 8, color: '#9ca3af', fontSize: 11 }}>{new Date(e.timestamp).toLocaleString()}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'credentials' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>Account SID</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <input readOnly value={provider.account_sid} style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'monospace', background: '#f9fafb' }} />
                                <button style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', cursor: 'pointer' }}><Copy size={14} /></button>
                            </div>
                        </div>
                        <div>
                            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>Auth Token</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <input readOnly value="••••••••••••••••••••••••••••••••" type="password" style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'monospace', background: '#f9fafb' }} />
                                <button style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 12, color: '#6b7280' }}>Reveal</button>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button style={{ padding: '8px 16px', fontSize: 13, background: '#fff', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 8, cursor: 'pointer' }}>Rotate Credentials</button>
                            <button style={{ padding: '8px 16px', fontSize: 13, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Test Connection</button>
                        </div>
                    </div>
                )}

                {activeTab === 'webhooks' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>Voice Inbound Webhook URL</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <input readOnly value={provider.webhook_url} style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'monospace', background: '#f9fafb' }} />
                                <button style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', cursor: 'pointer' }}><Copy size={14} /></button>
                            </div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                            <span style={{ fontSize: 13, color: '#6b7280' }}>Signature Validation</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                {provider.webhook_signature_valid ? <CheckCircle size={14} style={{ color: '#10b981' }} /> : <AlertCircle size={14} style={{ color: '#ef4444' }} />}
                                <span style={{ fontSize: 13, fontWeight: 500, color: provider.webhook_signature_valid ? '#10b981' : '#ef4444' }}>{provider.webhook_signature_valid ? 'Valid' : 'Invalid'}</span>
                            </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0' }}>
                            <span style={{ fontSize: 13, color: '#6b7280' }}>Status Callback URL</span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#6b7280' }}>{provider.webhook_url.replace('/inbound', '/status')}</span>
                        </div>
                    </div>
                )}

                {activeTab === 'numbers' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 13 }}><strong>{provider.numbers_synced}</strong> numbers synced from {provider.name}</span>
                            <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', fontSize: 13, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}><RefreshCw size={14} />Sync Now</button>
                        </div>
                        <div style={{ padding: 16, background: '#f9fafb', borderRadius: 8, fontSize: 13, color: '#6b7280' }}>
                            Default behavior: new numbers from provider are assigned to the <strong>Dispatch</strong> group automatically.
                        </div>
                        <button style={{ alignSelf: 'flex-start', padding: '8px 16px', fontSize: 13, background: '#fff', color: '#6366f1', border: '1px solid #6366f1', borderRadius: 8, cursor: 'pointer' }}>Test Inbound Route</button>
                    </div>
                )}

                {activeTab === 'cli' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>Common Twilio CLI commands for debugging and management:</div>
                        {[
                            { label: 'List numbers', cmd: 'twilio api:core:incoming-phone-numbers:list' },
                            { label: 'Check voice URL', cmd: 'twilio api:core:incoming-phone-numbers:fetch --sid PNxxxxxxxx' },
                            { label: 'Update voice URL', cmd: 'twilio api:core:incoming-phone-numbers:update --sid PNxxxxxxxx --voice-url https://...' },
                            { label: 'List calls', cmd: 'twilio api:core:calls:list --limit 10' },
                        ].map(c => (
                            <div key={c.label} style={{ background: '#1e1e2e', borderRadius: 8, padding: '10px 14px' }}>
                                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}># {c.label}</div>
                                <code style={{ fontSize: 12, color: '#a5f3fc', fontFamily: 'monospace' }}>{c.cmd}</code>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

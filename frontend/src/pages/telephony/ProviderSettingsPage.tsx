import { useState, useEffect } from 'react';
import { Shield, CheckCircle, AlertCircle, RefreshCw, Key, Webhook } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { ProviderInfo } from '../../types/telephony';

export default function ProviderSettingsPage() {
    const [provider, setProvider] = useState<ProviderInfo | null>(null);
    useEffect(() => { telephonyApi.getProvider().then(setProvider); }, []);
    if (!provider) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>;

    const sectionStyle = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 };
    const sectionTitle = (icon: React.ReactNode, title: string) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {icon}
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111' }}>{title}</div>
        </div>
    );

    return (
        <div style={{ padding: 24, maxWidth: 800 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
                <Shield size={20} style={{ color: '#6366f1' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Provider Settings</h1>
            </div>

            {/* Overview */}
            <div style={sectionStyle}>
                {sectionTitle(<CheckCircle size={16} style={{ color: '#6366f1' }} />, 'Overview')}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Connection</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {provider.status === 'connected' ? <CheckCircle size={14} style={{ color: '#10b981' }} /> : <AlertCircle size={14} style={{ color: '#ef4444' }} />}
                            <span style={{ fontSize: 14, fontWeight: 600, color: provider.status === 'connected' ? '#10b981' : '#ef4444' }}>{provider.name} — {provider.status}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Account: {provider.account_sid}</div>
                    </div>
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Numbers Synced</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: '#6366f1' }}>{provider.numbers_synced}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <RefreshCw size={12} />Last sync: {provider.last_sync}
                        </div>
                    </div>
                </div>
            </div>

            {/* Credentials */}
            <div style={sectionStyle}>
                {sectionTitle(<Key size={16} style={{ color: '#f59e0b' }} />, 'Credentials')}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Account SID</div>
                        <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#374151', padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>{provider.account_sid}</div>
                    </div>
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Auth Token</div>
                        <div style={{ fontSize: 13, fontFamily: 'monospace', color: '#374151', padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>••••••••••••••••</div>
                    </div>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>Credentials are managed via environment variables for security.</div>
            </div>

            {/* Webhooks */}
            <div style={sectionStyle}>
                {sectionTitle(<Webhook size={16} style={{ color: '#8b5cf6' }} />, 'Webhooks')}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                        { label: 'Voice URL', url: '/api/twilio/voice' },
                        { label: 'Status Callback', url: '/api/twilio/status' },
                        { label: 'Fallback URL', url: '/api/twilio/fallback' },
                    ].map(wh => (
                        <div key={wh.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f9fafb', borderRadius: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: '#374151' }}>{wh.label}</span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#6366f1' }}>{wh.url}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

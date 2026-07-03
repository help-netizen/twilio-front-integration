import { useState, useEffect } from 'react';
import { CheckCircle, AlertCircle, Database } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import { SettingsSection } from '../../components/settings/SettingsSection';
import type { ProviderInfo } from '../../types/telephony';

const OK = 'var(--blanc-success)';
const DANGER = 'var(--blanc-danger)';
const SUBTLE = 'rgba(25, 25, 25, 0.04)';

export default function ProviderSettingsPage() {
    const [provider, setProvider] = useState<ProviderInfo | null>(null);
    useEffect(() => { telephonyApi.getProvider().then(setProvider); }, []);
    if (!provider) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--blanc-ink-3)' }}>Loading…</div>;

    const connected = provider.status === 'connected';
    const label = (text: string) => <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--blanc-ink-3)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 4 }}>{text}</div>;
    const mono = { fontSize: 13, fontFamily: 'monospace', color: 'var(--blanc-ink-2)', padding: '6px 10px', background: SUBTLE, borderRadius: 8 };

    return (
        <SettingsPageShell eyebrow="Telephony" title="Connection">
            <SettingsSection title="Overview">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                    <div>
                        {label('Connection')}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {connected ? <CheckCircle size={14} style={{ color: OK }} /> : <AlertCircle size={14} style={{ color: DANGER }} />}
                            <span style={{ fontSize: 14, fontWeight: 600, color: connected ? OK : DANGER }}>{provider.name} — {provider.status}</span>
                        </div>
                        {provider.account_sid && <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', marginTop: 4 }}>Account: {provider.account_sid}</div>}
                    </div>
                    <div>
                        {label('Managed numbers')}
                        <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--blanc-accent)', fontFamily: 'var(--blanc-font-heading)' }}>{provider.numbers_count}</div>
                        <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Database size={12} />Source: Phone Numbers inventory
                        </div>
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection title="Credentials" description="Credentials are managed via environment variables for security.">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                    <div>
                        {label('Account SID')}
                        <div style={mono}>{provider.account_sid || 'Not configured'}</div>
                    </div>
                    <div>
                        {label('Auth token')}
                        <div style={mono}>••••••••••••••••</div>
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection title="Webhooks">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                        { label: 'Voice URL', url: '/api/twilio/voice' },
                        { label: 'Status Callback', url: '/api/twilio/status' },
                        { label: 'Fallback URL', url: '/api/twilio/fallback' },
                    ].map(wh => (
                        <div key={wh.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', background: SUBTLE, borderRadius: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--blanc-ink-2)' }}>{wh.label}</span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--blanc-accent)' }}>{wh.url}</span>
                        </div>
                    ))}
                </div>
            </SettingsSection>
        </SettingsPageShell>
    );
}

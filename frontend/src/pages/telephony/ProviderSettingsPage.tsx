import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle, AlertCircle, Database, Key, Webhook } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { ProviderInfo } from '../../types/telephony';

const INK1 = 'var(--blanc-ink-1, #202734)';
const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const JOB = 'var(--blanc-job, #2f63d8)';
const OK = 'var(--blanc-success, #1b8b63)';
const DANGER = 'var(--blanc-danger, #d44d3c)';
const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';
const SURFACE = 'var(--blanc-surface-strong, #fffdf9)';
const SUBTLE = 'rgba(117,106,89,0.04)';

export default function ProviderSettingsPage() {
    const [provider, setProvider] = useState<ProviderInfo | null>(null);
    useEffect(() => { telephonyApi.getProvider().then(setProvider); }, []);
    if (!provider) return <div style={{ padding: 40, textAlign: 'center', color: INK3 }}>Loading…</div>;

    const connected = provider.status === 'connected';
    const sectionStyle = { background: SURFACE, border: `1px solid ${LINE}`, borderRadius: 16, padding: 20, marginBottom: 16 };
    const sectionTitle = (icon: ReactNode, title: string) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {icon}
            <div style={{ fontSize: 15, fontWeight: 600, color: INK1 }}>{title}</div>
        </div>
    );
    const label = (text: string) => <div style={{ fontSize: 11, fontWeight: 600, color: INK3, textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 4 }}>{text}</div>;
    const mono = { fontSize: 13, fontFamily: 'monospace', color: INK2, padding: '6px 10px', background: SUBTLE, borderRadius: 8 };

    return (
        <div style={{ padding: '28px 24px', maxWidth: 1000 }}>
            <div className="blanc-eyebrow">Telephony</div>
            <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 24px', fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: INK1 }}>Connection</h1>

            <div style={sectionStyle}>
                {sectionTitle(<CheckCircle size={16} style={{ color: INK3 }} />, 'Overview')}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                    <div>
                        {label('Connection')}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {connected ? <CheckCircle size={14} style={{ color: OK }} /> : <AlertCircle size={14} style={{ color: DANGER }} />}
                            <span style={{ fontSize: 14, fontWeight: 600, color: connected ? OK : DANGER }}>{provider.name} — {provider.status}</span>
                        </div>
                        {provider.account_sid && <div style={{ fontSize: 12, color: INK3, marginTop: 4 }}>Account: {provider.account_sid}</div>}
                    </div>
                    <div>
                        {label('Managed numbers')}
                        <div style={{ fontSize: 28, fontWeight: 700, color: JOB, fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif' }}>{provider.numbers_count}</div>
                        <div style={{ fontSize: 12, color: INK3, display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                            <Database size={12} />Source: Phone Numbers inventory
                        </div>
                    </div>
                </div>
            </div>

            <div style={sectionStyle}>
                {sectionTitle(<Key size={16} style={{ color: INK3 }} />, 'Credentials')}
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
                <div style={{ fontSize: 11, color: INK3, marginTop: 8 }}>Credentials are managed via environment variables for security.</div>
            </div>

            <div style={sectionStyle}>
                {sectionTitle(<Webhook size={16} style={{ color: INK3 }} />, 'Webhooks')}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                        { label: 'Voice URL', url: '/api/twilio/voice' },
                        { label: 'Status Callback', url: '/api/twilio/status' },
                        { label: 'Fallback URL', url: '/api/twilio/fallback' },
                    ].map(wh => (
                        <div key={wh.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', background: SUBTLE, borderRadius: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: INK2 }}>{wh.label}</span>
                            <span style={{ fontSize: 12, fontFamily: 'monospace', color: JOB }}>{wh.url}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

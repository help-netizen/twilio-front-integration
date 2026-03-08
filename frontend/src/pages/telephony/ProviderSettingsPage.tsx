import { useState, useEffect } from 'react';
import { Shield, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import type { ProviderInfo } from '../../types/telephony';

export default function ProviderSettingsPage() {
    const [provider, setProvider] = useState<ProviderInfo | null>(null);
    const [activeTab, setActiveTab] = useState('overview');
    useEffect(() => { telephonyApi.getProvider().then(setProvider); }, []);
    if (!provider) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>;
    const tabs = ['Overview', 'Credentials', 'Webhooks', 'Number Sync'];
    return (
        <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <Shield size={20} style={{ color: '#6366f1' }} />
                <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Provider Settings</h1>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb', paddingBottom: 0 }}>
                {tabs.map(t => <button key={t} onClick={() => setActiveTab(t.toLowerCase().replace(' ', '_'))} style={{ padding: '8px 16px', fontSize: 13, fontWeight: activeTab === t.toLowerCase().replace(' ', '_') ? 600 : 400, color: activeTab === t.toLowerCase().replace(' ', '_') ? '#6366f1' : '#6b7280', background: 'none', border: 'none', borderBottom: activeTab === t.toLowerCase().replace(' ', '_') ? '2px solid #6366f1' : '2px solid transparent', cursor: 'pointer' }}>{t}</button>)}
            </div>
            {activeTab === 'overview' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Connection Status</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            {provider.status === 'connected' ? <CheckCircle size={16} style={{ color: '#10b981' }} /> : <AlertCircle size={16} style={{ color: '#ef4444' }} />}
                            <span style={{ fontSize: 15, fontWeight: 600, color: provider.status === 'connected' ? '#10b981' : '#ef4444' }}>{provider.name} — {provider.status}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>Account: {provider.account_sid}</div>
                    </div>
                    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Numbers Synced</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: '#6366f1' }}>{provider.numbers_synced}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                            <RefreshCw size={12} />Last sync: {provider.last_sync}
                        </div>
                    </div>
                </div>
            )}
            {activeTab === 'credentials' && <div style={{ padding: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}><p style={{ fontSize: 13, color: '#6b7280' }}>Account SID and Auth Token settings. Configure via environment variables for security.</p></div>}
            {activeTab === 'webhooks' && <div style={{ padding: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}><p style={{ fontSize: 13, color: '#6b7280' }}>Webhook endpoints for voice, status callbacks, and fallback URLs.</p></div>}
            {activeTab === 'number_sync' && <div style={{ padding: 20, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}><p style={{ fontSize: 13, color: '#6b7280' }}>Sync phone numbers from Twilio. Last sync: {provider.last_sync}.</p></div>}
        </div>
    );
}

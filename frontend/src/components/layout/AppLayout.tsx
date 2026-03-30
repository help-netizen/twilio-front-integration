import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { authedFetch } from '../../services/apiClient';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Phone } from 'lucide-react';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useTwilioDevice } from '../../hooks/useTwilioDevice';
import { SoftPhoneWidget } from '../softphone/SoftPhoneWidget';
import { SoftPhoneProvider } from '../../contexts/SoftPhoneContext';
import { warmUpAudio } from '../../utils/ringtone';
import { SoftPhoneHeaderButton } from './SoftPhoneHeaderButton';
import { AppNavTabs, SettingsMenu, getActiveTab } from './appLayoutNavigation';
import './AppLayout.css';

interface AppLayoutProps { children: React.ReactNode; }

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();
    const activeTab = getActiveTab(location.pathname);
    const { accessDeniedMessage, clearAccessDenied, logout, hasRole, company } = useAuth();

    const voice = useTwilioDevice();
    const [softPhoneOpen, setSoftPhoneOpen] = useState(false);
    const [softPhoneMinimized, setSoftPhoneMinimized] = useState(false);
    const [showWarmUp, setShowWarmUp] = useState(false);

    useEffect(() => { if (voice.phoneAllowed && voice.deviceReady) setShowWarmUp(true); }, [voice.phoneAllowed, voice.deviceReady]);
    const handleWarmUpDismiss = useCallback(() => { warmUpAudio(); setShowWarmUp(false); }, []);

    const handleAcceptIncoming = useCallback(() => {
        setSoftPhoneOpen(true); setSoftPhoneMinimized(false);
        setTimeout(() => voice.acceptCall(), 100);
        const num = voice.callerInfo?.number;
        if (num) authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(num)}`).then(r => r.json()).then(d => { if (d.timelineId) navigate(`/pulse/timeline/${d.timelineId}`); }).catch(() => { });
    }, [voice, navigate]);

    const [incomingCallerName, setIncomingCallerName] = useState<string | null>(null);
    useEffect(() => { if (!voice.incomingCall) { setIncomingCallerName(null); return; } const p = voice.callerInfo?.number; if (!p) return; authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(p)}`).then(r => r.json()).then(d => { if (d.contactName) setIncomingCallerName(d.contactName); }).catch(() => { }); }, [voice.incomingCall, voice.callerInfo?.number]);

    const [pulseUnreadCount, setPulseUnreadCount] = useState(0);
    const fetchUnreadCount = useCallback(async () => { 
        if (!company) return;
        try { 
            const res = await authedFetch('/api/pulse/unread-count'); 
            const data = await res.json(); 
            setPulseUnreadCount(data.count || 0); 
        } catch { } 
    }, [company]);
    useEffect(() => { fetchUnreadCount(); }, [fetchUnreadCount, location.pathname]);
    useRealtimeEvents({ onCallCreated: () => fetchUnreadCount(), onCallUpdate: () => fetchUnreadCount(), onMessageAdded: () => fetchUnreadCount(), onContactRead: () => fetchUnreadCount() });

    const handleRefresh = async () => {
        if (!company) return;
        setIsRefreshing(true);
        try { const r = await authedFetch('/api/sync/today', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); const d = await r.json(); if (d.success) { await queryClient.invalidateQueries({ queryKey: ['calls-by-contact'] }); await queryClient.invalidateQueries({ queryKey: ['contact-calls'] }); alert(`✅ Synced ${d.synced} new calls from last 3 days (${d.total} total found)`); } else alert(`❌ Sync failed: ${d.error}`); }
        catch (error) { console.error('Refresh failed:', error); alert('❌ Failed to refresh calls.'); } finally { setIsRefreshing(false); }
    };

    return (
        <SoftPhoneProvider onOpenRequested={() => { setSoftPhoneOpen(true); setSoftPhoneMinimized(false); }}>
            <div className="app-layout">
                <header className="app-header"><div className="header-content">
                    <AppNavTabs activeTab={activeTab} pulseUnreadCount={pulseUnreadCount} hasRole={hasRole} logout={logout} />
                    <div className="header-actions">
                        {voice.phoneAllowed && <SoftPhoneHeaderButton voice={voice} softPhoneOpen={softPhoneOpen} softPhoneMinimized={softPhoneMinimized} onAcceptIncoming={handleAcceptIncoming} incomingCallerName={incomingCallerName} onOpenOrRestore={() => { if (softPhoneMinimized) setSoftPhoneMinimized(false); else setSoftPhoneOpen(true); }} />}
                        {activeTab === 'calls' && <button onClick={handleRefresh} disabled={isRefreshing} className="refresh-button" title="Refresh calls from last 3 days from Twilio">{isRefreshing ? '🔄 Refreshing...' : '🔄 Refresh'}</button>}
                        <SettingsMenu activeTab={activeTab} hasRole={hasRole} logout={logout} />
                    </div>
                </div></header>
                <main className="app-main">
                    {accessDeniedMessage && <div style={{ position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)', zIndex: 9999, background: '#dc2626', color: '#fff', padding: '12px 24px', borderRadius: '8px', fontWeight: 500, fontSize: '14px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', gap: '12px' }}><span>🚫 {accessDeniedMessage}</span><button onClick={clearAccessDenied} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '16px', padding: 0 }}>×</button></div>}
                    {children}
                </main>
                <Dialog open={showWarmUp && !location.pathname.startsWith('/schedule')} onOpenChange={open => { if (!open) handleWarmUpDismiss(); }}><DialogContent className="sm:max-w-[360px]" onPointerDownOutside={e => e.preventDefault()}><DialogHeader className="text-center sm:text-center"><div className="flex justify-center mb-2"><Phone className="size-8 text-primary" /></div><DialogTitle>SoftPhone Ready</DialogTitle><DialogDescription>Enable incoming call ringtone so you don't miss any calls.</DialogDescription></DialogHeader><DialogFooter className="sm:justify-center"><Button onClick={handleWarmUpDismiss} size="lg" className="w-full"><Phone />Enable Ringtone</Button></DialogFooter></DialogContent></Dialog>
                <SoftPhoneWidget voice={voice} open={softPhoneOpen} minimized={softPhoneMinimized} onClose={() => { setSoftPhoneOpen(false); setSoftPhoneMinimized(false); }} onMinimize={() => setSoftPhoneMinimized(true)} />
            </div>
        </SoftPhoneProvider>
    );
};

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { authedFetch } from '../../services/apiClient';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useTwilioDevice } from '../../hooks/useTwilioDevice';
import { useIsMobile, useIsMobileDevice } from '../../hooks/useIsMobile';
import { SoftPhoneWidget } from '../softphone/SoftPhoneWidget';
import { WarmUpSummaryDialog } from './WarmUpSummaryDialog';
import { SoftPhoneProvider } from '../../contexts/SoftPhoneContext';
import { warmUpAudio } from '../../utils/ringtone';
import { SoftPhoneHeaderButton } from './SoftPhoneHeaderButton';
import { AppNavTabs, SettingsMenu, BottomNavBar, getActiveTab } from './appLayoutNavigation';
import { AutonomousModeBanner } from './AutonomousModeBanner';
import { useAutonomousMode } from '../../hooks/useAutonomousMode';
import { AutonomousModeProvider } from '../../contexts/AutonomousModeContext';
import { FeedbackWidget, isFeedbackWidgetEnabled } from '../feedback/FeedbackWidget';
import './AppLayout.css';

interface AppLayoutProps { children: React.ReactNode; }

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();
    const activeTab = getActiveTab(location.pathname);

    const { accessDeniedMessage, clearAccessDenied, logout, hasRole, company } = useAuth();

    const [softPhoneGroups, setSoftPhoneGroups] = useState<any[]>([]);
    const [softPhoneGroupsLoaded, setSoftPhoneGroupsLoaded] = useState(false);
    // MOBILE-NO-SOFTPHONE-001: the browser softphone (Twilio WebRTC Device) is
    // unreliable on mobile (backgrounded tab drops registration → no ring; flaky
    // audio), so fully disable it on mobile — no Device registration, no nav button,
    // no warm-up modal, no widget, no incoming-call screen. Desktop unchanged.
    const isMobile = useIsMobile();
    // SOFTPHONE-WARMUP-SUMMARY-001: capability gate (narrow viewport OR coarse
    // primary pointer) — softphone/warm-up belts ONLY; layout keeps useIsMobile.
    const isMobileDevice = useIsMobileDevice();
    // TELEPHONY-AUTONOMOUS-MODE-001: one fetch-on-mount instance for the whole shell.
    // The banner reads it here; the telephony toggle page reads/writes the SAME
    // instance via AutonomousModeProvider so toggling updates the banner immediately.
    const autonomous = useAutonomousMode();
    const softPhoneEnabled = !isMobile && !isMobileDevice && softPhoneGroupsLoaded && softPhoneGroups.length > 0;
    const voice = useTwilioDevice({ enabled: softPhoneEnabled });
    const [softPhoneOpen, setSoftPhoneOpen] = useState(false);
    const [softPhoneMinimized, setSoftPhoneMinimized] = useState(false);
    const [showWarmUp, setShowWarmUp] = useState(false);

    useEffect(() => {
        if (!company) {
            setSoftPhoneGroups([]);
            setSoftPhoneGroupsLoaded(false);
            return;
        }
        let cancelled = false;
        setSoftPhoneGroupsLoaded(false);
        authedFetch('/api/user-groups/my')
            .then(r => r.json())
            .then(data => {
                if (cancelled) return;
                setSoftPhoneGroups(Array.isArray(data.data) ? data.data : []);
                setSoftPhoneGroupsLoaded(true);
            })
            .catch(() => {
                if (cancelled) return;
                setSoftPhoneGroups([]);
                setSoftPhoneGroupsLoaded(true);
            });
        return () => { cancelled = true; };
    }, [company]);

    // SOFTPHONE-WARMUP-SUMMARY-001 belt 2a: explicit !isMobile/!isMobileDevice
    // terms (NOT via softPhoneEnabled indirection) — belts stay independent.
    // OB-6 belt 4: the modal is once-per-session (sessionStorage latch) and is
    // NEVER shown while a call is live. Root cause of the reappear-every-2-3-min
    // was the deviceReady flip (fixed at source in AuthProvider — identity-stable
    // company); these two guards are defense-in-depth so a future flip can't
    // interrupt an operator or re-nag them.
    useEffect(() => {
        if (isMobile || isMobileDevice || !softPhoneEnabled || !voice.phoneAllowed || !voice.deviceReady) return;
        if (voice.callState !== 'idle') return;                       // never over a live/incoming call
        try { if (sessionStorage.getItem('albusto_warmup_shown') === '1') return; } catch { /* ignore */ }
        setShowWarmUp(true);
    }, [isMobile, isMobileDevice, softPhoneEnabled, voice.phoneAllowed, voice.deviceReady, voice.callState]);
    // Belt 3: reset-on-flip — a latch armed during a transient wrong-width
    // window cannot survive the flags going mobile.
    useEffect(() => { if (isMobile || isMobileDevice) setShowWarmUp(false); }, [isMobile, isMobileDevice]);
    // §6.3 DEV-only preview: dead code in prod (Vite statically replaces
    // import.meta.env.DEV with false). Belts still gate the preview.
    const warmUpPreview = import.meta.env.DEV && new URLSearchParams(location.search).get('warmup') === 'preview';
    // Iteration #3: optional &counts=a,b,c overrides the trio in preview mode
    // (first value = pulseInbox directly, no AR summing; 'x' or missing → null).
    // Same DEV-gated expression scope → statically dead in prod.
    const warmUpPreviewCounts = import.meta.env.DEV && warmUpPreview
        ? (() => {
            const raw = new URLSearchParams(location.search).get('counts');
            if (raw === null) return null;
            const parts = raw.split(',');
            const num = (s: string | undefined) => {
                const n = Number(s);
                return s !== undefined && s !== '' && Number.isFinite(n) ? n : null;
            };
            return { pulseInbox: num(parts[0]), newLeads: num(parts[1]), openTasks: num(parts[2]) };
        })()
        : null;
    // OB-6: latch once dismissed so a later deviceReady flip can't re-nag this session.
    const latchWarmUpShown = () => { try { sessionStorage.setItem('albusto_warmup_shown', '1'); } catch { /* ignore */ } };
    const handleWarmUpDismiss = useCallback(() => {
        warmUpAudio(); // gesture canon: FIRST synchronous statement on every dismiss path
        setShowWarmUp(false);
        if (!warmUpPreview) latchWarmUpShown();
        if (warmUpPreview) navigate(location.pathname, { replace: true }); // strip ?warmup=preview so dismiss sticks
    }, [warmUpPreview, navigate, location.pathname]);
    const handleSummaryNavigate = useCallback((path: string) => {
        warmUpAudio(); // gesture canon: FIRST synchronous statement
        setShowWarmUp(false);
        if (!warmUpPreview) latchWarmUpShown();
        navigate(path); // replaces location → preview param dropped naturally
    }, [navigate, warmUpPreview]);

    const handleAcceptIncoming = useCallback(() => {
        setSoftPhoneOpen(true); setSoftPhoneMinimized(false);
        setTimeout(() => voice.acceptCall(), 100);
        const num = voice.callerInfo?.number;
        if (num) authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(num)}`).then(r => r.json()).then(d => { if (d.timelineId) navigate(`/pulse/timeline/${d.timelineId}`); }).catch(() => { });
    }, [voice, navigate]);

    // Auto-open softphone panel when an incoming/promoted call arrives
    useEffect(() => {
        if (softPhoneEnabled && voice.callState === 'incoming') {
            setSoftPhoneOpen(true);
            setSoftPhoneMinimized(false);
        }
    }, [softPhoneEnabled, voice.callState]);

    const [incomingCallerName, setIncomingCallerName] = useState<string | null>(null);
    useEffect(() => { if (!voice.incomingCall) { setIncomingCallerName(null); return; } const p = voice.callerInfo?.number; if (!p) return; authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(p)}`).then(r => r.json()).then(d => { if (d.contactName) setIncomingCallerName(d.contactName); }).catch(() => { }); }, [voice.incomingCall, voice.callerInfo?.number]);

    // SOFTPHONE-WARMUP-SUMMARY-001 §4.1: number|null (null = not-yet-loaded →
    // "—" in the summary modal); nav badges coerce `?? 0` at the prop lines.
    const [pulseUnreadCount, setPulseUnreadCount] = useState<number | null>(null);
    const fetchUnreadCount = useCallback(async () => {
        if (!company) return;
        try {
            const res = await authedFetch('/api/pulse/unread-count');
            const data = await res.json();
            setPulseUnreadCount(data.count || 0);
        } catch { }
    }, [company]);
    useEffect(() => { fetchUnreadCount(); }, [fetchUnreadCount, location.pathname]);

    // LEADS-NEW-BADGE-001: count of new/unactioned leads (Submitted/New/Review) for
    // the Leads nav badge. Hybrid freshness: mount + route change + 60s poll +
    // SSE (lead.created/lead.updated), the poll being the fallback for missed
    // events / reconnects. Response shape = successResponse → data.data.count.
    const [leadsNewCount, setLeadsNewCount] = useState<number | null>(null);
    const fetchLeadsNewCount = useCallback(async () => {
        if (!company) return;
        try {
            const res = await authedFetch('/api/leads/new-count');
            const json = await res.json();
            setLeadsNewCount(json?.data?.count ?? json?.count ?? 0);
        } catch { }
    }, [company]);
    useEffect(() => { fetchLeadsNewCount(); }, [fetchLeadsNewCount, location.pathname]);
    useEffect(() => {
        if (!company) return;
        const t = setInterval(() => fetchLeadsNewCount(), 60000);
        return () => clearInterval(t);
    }, [company, fetchLeadsNewCount]);

    // TASKS-COUNT-BADGE-001: count of open tasks visible to the current user for
    // the Tasks nav badge. Server-scoped (manager = all company open tasks, others
    // = own) — never computed client-side. Same freshness recipe as Leads: mount +
    // route change + 60s poll + SSE (task.changed), the poll being the fallback for
    // missed events / reconnects. Response shape = { ok, data:{ count } }.
    const [openTasksCount, setOpenTasksCount] = useState<number | null>(null);
    const fetchOpenTasksCount = useCallback(async () => {
        if (!company) return;
        try {
            const res = await authedFetch('/api/tasks/count');
            const json = await res.json();
            setOpenTasksCount(json?.data?.count ?? json?.count ?? 0);
        } catch { }
    }, [company]);
    useEffect(() => { fetchOpenTasksCount(); }, [fetchOpenTasksCount, location.pathname]);
    useEffect(() => {
        if (!company) return;
        const t = setInterval(() => fetchOpenTasksCount(), 60000);
        return () => clearInterval(t);
    }, [company, fetchOpenTasksCount]);

    // SOFTPHONE-WARMUP-SUMMARY-001 §4.2: open Action-Required count (open tasks
    // with parent_type=timeline) — feeds ONLY the summary modal's Pulse-inbox
    // column (unread + AR). Fetched per modal-arm; NO poll, NO SSE; nav badges
    // never read it. Fail-silent: stays null → "—".
    const [arCount, setArCount] = useState<number | null>(null);
    const fetchArCount = useCallback(async () => {
        if (!company) return;
        try {
            const res = await authedFetch('/api/tasks/count?parent_type=timeline');
            const json = await res.json();
            setArCount(json?.data?.count ?? json?.count ?? 0);
        } catch { }
    }, [company]);
    useEffect(() => { if (showWarmUp || warmUpPreview) fetchArCount(); }, [showWarmUp, warmUpPreview, fetchArCount]);

    useRealtimeEvents({
        onCallCreated: () => fetchUnreadCount(),
        onCallUpdate: () => fetchUnreadCount(),
        onMessageAdded: () => fetchUnreadCount(),
        onContactRead: () => fetchUnreadCount(),
        // SSE fans out to ALL tenants → only refetch for our own company.
        onGenericEvent: (type, d) => {
            if ((type === 'lead.created' || type === 'lead.updated') && d?.company_id === company?.id) {
                fetchLeadsNewCount();
            }
            if (type === 'task.changed' && d?.company_id === company?.id) {
                fetchOpenTasksCount();
            }
        },
    });

    const handleRefresh = async () => {
        if (!company) return;
        setIsRefreshing(true);
        try { const r = await authedFetch('/api/sync/today', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); const d = await r.json(); if (d.success) { await queryClient.invalidateQueries({ queryKey: ['calls-by-contact'] }); await queryClient.invalidateQueries({ queryKey: ['contact-calls'] }); alert(`✅ Synced ${d.synced} new calls from last 3 days (${d.total} total found)`); } else alert(`❌ Sync failed: ${d.error}`); }
        catch (error) { console.error('Refresh failed:', error); alert('❌ Failed to refresh calls.'); } finally { setIsRefreshing(false); }
    };

    // ALB-101: auth pages render bare — no header/nav/softphone chrome.
    // (After all hooks to keep the hook order stable.)
    if (location.pathname.startsWith('/signup') || location.pathname.startsWith('/onboarding') || location.pathname.startsWith('/r/')) {
        return <>{children}</>;
    }

    return (
        <SoftPhoneProvider onOpenRequested={() => { setSoftPhoneOpen(true); setSoftPhoneMinimized(false); }}>
          <AutonomousModeProvider value={autonomous}>
            <div className={`app-layout${autonomous.autonomousMode ? ' has-autonomous-banner' : ''}`}>
                <header className="app-header"><div className="header-content">
                    <AppNavTabs activeTab={activeTab} pulseUnreadCount={pulseUnreadCount ?? 0} leadsNewCount={leadsNewCount ?? 0} openTasksCount={openTasksCount ?? 0} hasRole={hasRole} logout={logout} />
                    <div className="header-actions">
                        {softPhoneEnabled && voice.phoneAllowed && <SoftPhoneHeaderButton voice={voice} softPhoneOpen={softPhoneOpen} softPhoneMinimized={softPhoneMinimized} onAcceptIncoming={handleAcceptIncoming} incomingCallerName={incomingCallerName} onOpenOrRestore={() => { if (softPhoneMinimized) setSoftPhoneMinimized(false); else setSoftPhoneOpen(true); }} />}
                        {activeTab === 'calls' && <button onClick={handleRefresh} disabled={isRefreshing} className="refresh-button" title="Refresh calls from last 3 days from Twilio">{isRefreshing ? '🔄 Refreshing...' : '🔄 Refresh'}</button>}
                        <SettingsMenu activeTab={activeTab} hasRole={hasRole} logout={logout} />
                    </div>
                </div></header>
                <BottomNavBar activeTab={activeTab} pulseUnreadCount={pulseUnreadCount ?? 0} leadsNewCount={leadsNewCount ?? 0} openTasksCount={openTasksCount ?? 0} />
                <main className="app-main">
                    {accessDeniedMessage && <div style={{ position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)', zIndex: 9999, background: '#dc2626', color: '#fff', padding: '12px 24px', borderRadius: '8px', fontWeight: 500, fontSize: '14px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', gap: '12px' }}><span>🚫 {accessDeniedMessage}</span><button onClick={clearAccessDenied} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '16px', padding: 0 }}>×</button></div>}
                    {children}
                </main>
                {/* SOFTPHONE-WARMUP-SUMMARY-001 belt 2b: render gate — /schedule term kept verbatim. */}
                <WarmUpSummaryDialog open={(showWarmUp || warmUpPreview) && !isMobile && !isMobileDevice && !location.pathname.startsWith('/schedule')} counts={warmUpPreviewCounts ?? { pulseInbox: pulseUnreadCount === null || arCount === null ? null : pulseUnreadCount + arCount, newLeads: leadsNewCount, openTasks: openTasksCount }} onNavigate={handleSummaryNavigate} onDismiss={handleWarmUpDismiss} />
                {!isMobile && !isMobileDevice && <SoftPhoneWidget voice={voice} open={softPhoneOpen} minimized={softPhoneMinimized} disabledReason={!softPhoneEnabled && softPhoneGroupsLoaded ? 'You are not assigned to any group. Ask your administrator.' : undefined} onClose={() => { setSoftPhoneOpen(false); setSoftPhoneMinimized(false); }} onMinimize={() => setSoftPhoneMinimized(true)} />}
                {isFeedbackWidgetEnabled(import.meta.env.VITE_FEATURE_FEEDBACK_WIDGET) && <FeedbackWidget />}
                <AutonomousModeBanner visible={autonomous.autonomousMode} />
            </div>
          </AutonomousModeProvider>
        </SoftPhoneProvider>
    );
};

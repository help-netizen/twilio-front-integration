import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { authedFetch } from '../../services/apiClient';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { Phone, PhoneIncoming, MessageSquare, Users, Settings, Key, BookOpen, FileText, LogOut, Shield, Activity, MessageSquareText, DollarSign, Contact2, Wrench, Briefcase } from 'lucide-react';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useTwilioDevice } from '../../hooks/useTwilioDevice';
import { SoftPhoneWidget } from '../softphone/SoftPhoneWidget';
import { formatPhoneDisplay } from '../../utils/phoneUtils';
import './AppLayout.css';

interface AppLayoutProps {
    children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();

    const activeTab = location.pathname.startsWith('/pulse') ? 'pulse'
        : location.pathname.startsWith('/messages') ? 'messages'
            : location.pathname.startsWith('/leads') ? 'leads'
                : location.pathname.startsWith('/jobs') ? 'jobs'
                    : location.pathname.startsWith('/contacts') ? 'contacts'
                        : location.pathname.startsWith('/settings') ? 'settings'
                            : location.pathname.startsWith('/calls') || location.pathname.startsWith('/contact/') ? 'calls'
                                : 'pulse';

    const { accessDeniedMessage, clearAccessDenied, logout, hasRole } = useAuth();

    // --- SoftPhone ---
    const voice = useTwilioDevice();
    const [softPhoneOpen, setSoftPhoneOpen] = useState(false);
    const [softPhoneMinimized, setSoftPhoneMinimized] = useState(false);

    // Auto-open SoftPhone on incoming call + navigate to caller's timeline
    const handleAcceptIncoming = useCallback(() => {
        setSoftPhoneOpen(true);
        setSoftPhoneMinimized(false);
        // Small delay to let the modal render, then accept
        setTimeout(() => voice.acceptCall(), 100);

        // Navigate to the caller's timeline
        const callerNumber = voice.callerInfo?.number;
        if (callerNumber) {
            authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(callerNumber)}`)
                .then(res => res.json())
                .then(data => {
                    if (data.timelineId) {
                        navigate(`/pulse/timeline/${data.timelineId}`);
                    }
                })
                .catch(() => { /* navigation is best-effort */ });
        }
    }, [voice, navigate]);

    // Resolve incoming caller's contact name
    const [incomingCallerName, setIncomingCallerName] = useState<string | null>(null);
    useEffect(() => {
        if (!voice.incomingCall) {
            setIncomingCallerName(null);
            return;
        }
        const phone = voice.callerInfo?.number;
        if (!phone) return;

        authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(phone)}`)
            .then(res => res.json())
            .then(data => {
                if (data.contactName) setIncomingCallerName(data.contactName);
            })
            .catch(() => { });
    }, [voice.incomingCall, voice.callerInfo?.number]);

    // --- Pulse unread badge ---
    const [pulseUnreadCount, setPulseUnreadCount] = useState(0);

    const fetchUnreadCount = useCallback(async () => {
        try {
            const res = await authedFetch('/api/pulse/unread-count');
            const data = await res.json();
            setPulseUnreadCount(data.count || 0);
        } catch { /* ignore */ }
    }, []);

    // Fetch on mount + when navigating
    useEffect(() => { fetchUnreadCount(); }, [fetchUnreadCount, location.pathname]);

    // Refresh unread count on SSE events
    useRealtimeEvents({
        onCallCreated: () => fetchUnreadCount(),
        onCallUpdate: () => fetchUnreadCount(),
        onMessageAdded: () => fetchUnreadCount(),
        onContactRead: () => fetchUnreadCount(),
    });

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            console.log('🔄 Refreshing last 3 days calls...');
            const response = await authedFetch('/api/sync/today', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();

            if (data.success) {
                await queryClient.invalidateQueries({ queryKey: ['calls-by-contact'] });
                await queryClient.invalidateQueries({ queryKey: ['contact-calls'] });
                alert(`✅ Synced ${data.synced} new calls from last 3 days (${data.total} total found)`);
            } else {
                alert(`❌ Sync failed: ${data.error}`);
            }
        } catch (error) {
            console.error('Refresh failed:', error);
            alert('❌ Failed to refresh calls. Check console for details.');
        } finally {
            setIsRefreshing(false);
        }
    };

    return (
        <div className="app-layout">
            <header className="app-header">
                <div className="header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
                        <h1 className="text-2xl font-semibold" style={{ margin: 0, color: '#202223' }}>Blanc</h1>
                        <Tabs value={activeTab} className="w-auto">
                            <TabsList>
                                <TabsTrigger
                                    value="pulse"
                                    className="flex items-center gap-2"
                                    onClick={() => navigate('/pulse')}
                                    style={{ position: 'relative' }}
                                >
                                    <Activity className="size-4" />
                                    Pulse
                                    {pulseUnreadCount > 0 && (
                                        <span
                                            className="pulse-unread-badge"
                                            title={`${pulseUnreadCount} unread`}
                                        >
                                            {pulseUnreadCount > 9 ? '9+' : pulseUnreadCount}
                                        </span>
                                    )}
                                </TabsTrigger>
                                <TabsTrigger
                                    value="calls"
                                    className="flex items-center gap-2"
                                    onClick={() => navigate('/calls')}
                                >
                                    <Phone className="size-4" />
                                    Calls
                                </TabsTrigger>
                                <TabsTrigger
                                    value="messages"
                                    className="flex items-center gap-2"
                                    onClick={() => navigate('/messages')}
                                >
                                    <MessageSquare className="size-4" />
                                    Messages
                                </TabsTrigger>
                                <TabsTrigger
                                    value="leads"
                                    className="flex items-center gap-2"
                                    onClick={() => navigate('/leads')}
                                >
                                    <Users className="size-4" />
                                    Leads
                                </TabsTrigger>
                                <TabsTrigger
                                    value="jobs"
                                    className="flex items-center gap-2"
                                    onClick={() => navigate('/jobs')}
                                >
                                    <Briefcase className="size-4" />
                                    Jobs
                                </TabsTrigger>
                                <TabsTrigger
                                    value="contacts"
                                    className="flex items-center gap-2"
                                    onClick={() => navigate('/contacts')}
                                >
                                    <Contact2 className="size-4" />
                                    Contacts
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>
                    </div>
                    <div className="header-actions">
                        {/* Global incoming call button */}
                        {voice.incomingCall && (
                            <button
                                className="incoming-call-btn"
                                onClick={handleAcceptIncoming}
                            >
                                <PhoneIncoming size={16} />
                                <span>
                                    {incomingCallerName || (voice.callerInfo?.number ? formatPhoneDisplay(voice.callerInfo.number) : 'Unknown')}
                                </span>
                                — Accept
                            </button>
                        )}
                        {voice.phoneAllowed && (
                            <button
                                onClick={() => setSoftPhoneOpen(true)}
                                className="softphone-header-btn"
                                title="Open SoftPhone"
                            >
                                <Phone size={15} />
                                <span>SoftPhone</span>
                            </button>
                        )}
                        {activeTab === 'calls' && (
                            <button
                                onClick={handleRefresh}
                                disabled={isRefreshing}
                                className="refresh-button"
                                title="Refresh calls from last 3 days from Twilio"
                            >
                                {isRefreshing ? '🔄 Refreshing...' : '🔄 Refresh'}
                            </button>
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    className="user-menu"
                                    style={{ cursor: 'pointer', fontWeight: activeTab === 'settings' ? 600 : 400 }}
                                >
                                    <Settings className="size-4" style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                                    Settings
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/integrations')}
                                >
                                    <Key className="size-4" />
                                    Integrations
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/lead-form')}
                                >
                                    <FileText className="size-4" />
                                    Lead & Job
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/quick-messages')}
                                >
                                    <MessageSquareText className="size-4" />
                                    Quick Messages
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/payments')}
                                >
                                    <DollarSign className="size-4" />
                                    Payments
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/api-docs')}
                                >
                                    <BookOpen className="size-4" />
                                    API Docs
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/users')}
                                >
                                    <Users className="size-4" />
                                    Users
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/providers')}
                                >
                                    <Wrench className="size-4" />
                                    Providers
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer"
                                    onClick={() => navigate('/settings/phone-calls')}
                                >
                                    <Phone className="size-4" />
                                    Phone Calls
                                </DropdownMenuItem>
                                {hasRole('super_admin') && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            className="flex items-center gap-2 cursor-pointer"
                                            onClick={() => navigate('/settings/admin')}
                                        >
                                            <Shield className="size-4" />
                                            Super Admin
                                        </DropdownMenuItem>
                                    </>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    className="flex items-center gap-2 cursor-pointer text-red-600"
                                    onClick={logout}
                                >
                                    <LogOut className="size-4" />
                                    Log Out
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </header>

            <main className="app-main">
                {accessDeniedMessage && (
                    <div style={{
                        position: 'fixed',
                        top: '72px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 9999,
                        background: '#dc2626',
                        color: '#fff',
                        padding: '12px 24px',
                        borderRadius: '8px',
                        fontWeight: 500,
                        fontSize: '14px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                    }}>
                        <span>🚫 {accessDeniedMessage}</span>
                        <button
                            onClick={clearAccessDenied}
                            style={{
                                background: 'none', border: 'none', color: '#fff',
                                cursor: 'pointer', fontSize: '16px', padding: 0,
                            }}
                        >
                            ×
                        </button>
                    </div>
                )}
                {children}
            </main>

            {/* SoftPhone Panel */}
            <SoftPhoneWidget
                voice={voice}
                open={softPhoneOpen}
                minimized={softPhoneMinimized}
                onClose={() => { setSoftPhoneOpen(false); setSoftPhoneMinimized(false); }}
                onMinimize={() => setSoftPhoneMinimized(true)}
                onRestore={() => setSoftPhoneMinimized(false)}
            />
        </div>
    );
};


import React, { useState } from 'react';
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
import { Phone, MessageSquare, Users, Settings, Key, BookOpen, FileText, LogOut, Shield } from 'lucide-react';
import './AppLayout.css';

interface AppLayoutProps {
    children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();

    const activeTab = location.pathname.startsWith('/messages') ? 'messages'
        : location.pathname.startsWith('/leads') ? 'leads'
            : location.pathname.startsWith('/settings') ? 'settings'
                : 'calls';

    const { accessDeniedMessage, clearAccessDenied, logout, hasRole } = useAuth();

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
                            </TabsList>
                        </Tabs>
                    </div>
                    <div className="header-actions">
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
                                    Lead Form
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
        </div>
    );
};


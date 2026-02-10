import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Phone, Users } from 'lucide-react';
import './AppLayout.css';

interface AppLayoutProps {
    children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const queryClient = useQueryClient();
    const location = useLocation();
    const navigate = useNavigate();

    const activeTab = location.pathname.startsWith('/leads') ? 'leads' : 'calls';

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            console.log('🔄 Refreshing last 3 days calls...');
            const response = await fetch('/api/sync/today', {
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
                        <span className="user-menu">Settings</span>
                    </div>
                </div>
            </header>

            <main className="app-main">
                {children}
            </main>
        </div>
    );
};


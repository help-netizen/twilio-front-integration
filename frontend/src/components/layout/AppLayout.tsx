import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import './AppLayout.css';

interface AppLayoutProps {
    children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const queryClient = useQueryClient();

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
                // Invalidate all queries to refetch fresh data
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
                    <h1 className="logo">📞 Twilio Calls</h1>
                    <div className="header-actions">
                        <button
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            className="refresh-button"
                            title="Refresh calls from last 3 days from Twilio"
                        >
                            {isRefreshing ? '🔄 Refreshing...' : '🔄 Refresh'}
                        </button>
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

import React from 'react';
import TelephonyNav from './TelephonyNav';

interface TelephonyLayoutProps {
    children: React.ReactNode;
}

/**
 * Wraps telephony pages with a left-side nav sidebar.
 * Used inside AppLayout for /settings/telephony/* and /calls/* routes.
 */
export default function TelephonyLayout({ children }: TelephonyLayoutProps) {
    return (
        <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 56px)' }}>
            <TelephonyNav />
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {children}
            </div>
        </div>
    );
}

import React from 'react';
import TelephonyNav from './TelephonyNav';

export default function TelephonyLayout({ children }: { children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 56px)' }}>
            <TelephonyNav />
            <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
        </div>
    );
}

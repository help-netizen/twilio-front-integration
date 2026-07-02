import React from 'react';
import TelephonyNav from './TelephonyNav';
import { useIsMobile } from '../../hooks/useIsMobile';

export default function TelephonyLayout({ children }: { children: React.ReactNode }) {
    const isMobile = useIsMobile();

    if (isMobile) {
        // Mobile: stack — horizontal tab strip on top, content full-width below,
        // one scroll flow. 100dvh for PWA/browser consistency.
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100dvh - 56px)' }}>
                <TelephonyNav />
                <div style={{ flex: 1 }}>{children}</div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100dvh - 56px)' }}>
            <TelephonyNav />
            <div style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
        </div>
    );
}

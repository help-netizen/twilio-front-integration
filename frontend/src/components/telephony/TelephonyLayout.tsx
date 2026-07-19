import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthz } from '../../hooks/useAuthz';
import { authedFetch } from '../../services/apiClient';

// ONBTEL-001 §2.5: connection gate for all /settings/telephony/* pages.
// Each route wraps its page in this gate, so the gate remounts on every
// tab switch. A confirmed-connected result is cached module-wide to keep tab
// switches instant for connected companies; negative/error results are never
// cached, so a company that just connected in the wizard gets a fresh check
// on its next visit (no stale redirect back to the wizard).
type ConnState = 'loading' | 'connected' | 'not_connected' | 'error';
let cachedConnected = false;

export default function TelephonyLayout({ children }: { children: React.ReactNode }) {
    const { hasPermission } = useAuthz();
    const [connState, setConnState] = useState<ConnState>(cachedConnected ? 'connected' : 'loading');

    useEffect(() => {
        if (cachedConnected) return;
        let cancelled = false;
        (async () => {
            let next: ConnState = 'error';
            try {
                const r = await authedFetch('/api/telephony/numbers/status');
                const j = await r.json().catch(() => null);
                if (j?.state?.connected === true) next = 'connected';
                else if (r.ok && j?.ok === true && j?.state?.connected === false) next = 'not_connected';
                // anything else (5xx, malformed body) → 'error' → fail-open below
            } catch { /* network error → fail-open */ }
            if (next === 'connected') cachedConnected = true;
            if (!cancelled) setConnState(next);
        })();
        return () => { cancelled = true; };
    }, []);

    // Still resolving: render nothing — no flash of nav/children or redirect.
    if (connState === 'loading') return null;

    if (connState === 'not_connected') {
        if (hasPermission('tenant.integrations.manage')) {
            // Not connected + can manage integrations → the wizard owns the connect flow.
            return <Navigate to="/settings/integrations/telephony-twilio" replace />;
        }
        // Not connected, no integrations permission: dead-end empty state
        // (no redirect — the wizard route would 403 and loop).
        return (
            <div className="flex min-h-full items-center justify-center px-6 py-16">
                <p style={{ margin: 0, fontSize: 14, color: 'var(--blanc-ink-2, #536070)', textAlign: 'center' }}>
                    Telephony is not connected yet — ask your administrator.
                </p>
            </div>
        );
    }

    // 'connected' (incl. the DEFAULT master company) or 'error' (fail-open —
    // pages have their own not-connected states): the shared SettingsLayout owns
    // navigation, height, and scrolling for regular telephony pages.
    return <>{children}</>;
}

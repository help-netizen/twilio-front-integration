import React from 'react';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

export interface SessionInfo { id: string; userId: string; username: string; email: string; ipAddress: string; start: number; lastAccess: number; }

export interface AuthPolicy {
    password: { minLength: number; raw: string };
    session: { accessTokenLifespan: number; ssoSessionIdleTimeout: number; ssoSessionMaxLifespan: number };
    mfa: { otpPolicyType: string; otpPolicyDigits: number; otpPolicyPeriod: number };
    bruteForce: { enabled: boolean; maxFailureWaitSeconds: number; failureFactor: number };
}

export function fmt(seconds: number) {
    if (!seconds) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function fmtDate(ts: number) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
}

export function PolicyCard({ icon: Icon, label, value, variant }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    variant?: 'default' | 'destructive';
}) {
    return (
        <Card>
            <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-2"><Icon className="size-4 text-muted-foreground" /><span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span></div>
                <div className="text-sm font-semibold">{variant === 'destructive' ? <Badge variant="destructive">{value}</Badge> : value}</div>
            </CardContent>
        </Card>
    );
}

import { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog';
import { toast } from 'sonner';
import {
    Shield, Key, Users, Settings, ExternalLink,
    RefreshCw, Trash2, Globe, Clock, Lock, Fingerprint,
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const KC_URL = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const KC_REALM = import.meta.env.VITE_KEYCLOAK_REALM || 'crm-prod';

interface SessionInfo {
    id: string;
    userId: string;
    username: string;
    email: string;
    ipAddress: string;
    start: number;
    lastAccess: number;
}

interface AuthPolicy {
    password: { minLength: number; raw: string };
    session: {
        accessTokenLifespan: number;
        ssoSessionIdleTimeout: number;
        ssoSessionMaxLifespan: number;
    };
    mfa: { otpPolicyType: string; otpPolicyDigits: number; otpPolicyPeriod: number };
    bruteForce: { enabled: boolean; maxFailureWaitSeconds: number; failureFactor: number };
}

export default function SuperAdminPage() {
    const { token } = useAuth();
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [policy, setPolicy] = useState<AuthPolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [revoking, setRevoking] = useState<string | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{
        open: boolean;
        title: string;
        description: string;
        onConfirm: () => void;
    }>({ open: false, title: '', description: '', onConfirm: () => { } });

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const fetchData = async () => {
        setLoading(true);
        try {
            const [sessRes, polRes] = await Promise.all([
                fetch(`${API_BASE}/admin/sessions`, { headers }),
                fetch(`${API_BASE}/admin/sessions/auth-policy`, { headers }),
            ]);
            if (sessRes.ok) {
                const d = await sessRes.json();
                setSessions(d.sessions || []);
            } else {
                toast.error('Failed to load sessions');
            }
            if (polRes.ok) {
                const d = await polRes.json();
                setPolicy(d.policy || null);
            } else {
                toast.error('Failed to load auth policy');
            }
        } catch (e: any) {
            toast.error('Connection error', { description: e.message });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchData(); }, []);

    const revokeSession = async (sessionId: string) => {
        setRevoking(sessionId);
        try {
            const res = await fetch(`${API_BASE}/admin/sessions/${sessionId}`, { method: 'DELETE', headers });
            if (res.ok) {
                setSessions(prev => prev.filter(s => s.id !== sessionId));
                toast.success('Session revoked');
            } else {
                toast.error('Failed to revoke session');
            }
        } catch {
            toast.error('Failed to revoke session');
        }
        setRevoking(null);
    };

    const revokeAllSessions = async () => {
        setRevoking('all');
        try {
            const userIds = [...new Set(sessions.map(s => s.userId))];
            await Promise.all(userIds.map(uid =>
                fetch(`${API_BASE}/admin/sessions/user/${uid}`, { method: 'DELETE', headers })
            ));
            setSessions([]);
            toast.success('All sessions revoked');
        } catch {
            toast.error('Failed to revoke sessions');
        }
        setRevoking(null);
    };

    const fmt = (seconds: number) => {
        if (!seconds) return '—';
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    };

    const fmtDate = (ts: number) => {
        if (!ts) return '—';
        return new Date(ts).toLocaleString();
    };

    const quickLinks = [
        {
            icon: Key,
            title: 'Keycloak Admin Console',
            description: 'Realms, users, clients, identity settings',
            href: `${KC_URL}/admin/master/console`,
        },
        {
            icon: Users,
            title: 'User Management',
            description: `Manage users in ${KC_REALM}`,
            href: `${KC_URL}/admin/master/console/#/${KC_REALM}/users`,
        },
        {
            icon: Settings,
            title: 'Realm Settings',
            description: 'Token lifespans, login, email config',
            href: `${KC_URL}/admin/master/console/#/${KC_REALM}/realm-settings`,
        },
    ];

    return (
        <div className="max-w-4xl mx-auto p-6 space-y-8">
            {/* ── Header ─────────────────────────────────────── */}
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <Shield className="size-5 text-muted-foreground" />
                    <h2 className="text-xl font-semibold">Super Admin</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                    Session management, authentication policy, and admin tools.
                </p>
            </div>

            {/* ── Quick Links ────────────────────────────────── */}
            <section className="space-y-3">
                <h3 className="font-medium">Quick Links</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {quickLinks.map(link => (
                        <a
                            key={link.title}
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group block"
                        >
                            <Card className="h-full transition-colors hover:border-primary/40">
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <link.icon className="size-4 text-muted-foreground" />
                                        <ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </div>
                                    <CardTitle className="text-sm">{link.title}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <p className="text-xs text-muted-foreground">{link.description}</p>
                                </CardContent>
                            </Card>
                        </a>
                    ))}
                </div>
            </section>

            <Separator />

            {/* ── Auth Policy ────────────────────────────────── */}
            <section className="space-y-3">
                <h3 className="font-medium">Auth Policy</h3>
                {loading ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {[...Array(6)].map((_, i) => (
                            <Skeleton key={i} className="h-20 w-full" />
                        ))}
                    </div>
                ) : policy ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <PolicyCard
                            icon={Clock}
                            label="Access Token"
                            value={fmt(policy.session.accessTokenLifespan)}
                        />
                        <PolicyCard
                            icon={Clock}
                            label="Session Idle"
                            value={fmt(policy.session.ssoSessionIdleTimeout)}
                        />
                        <PolicyCard
                            icon={Clock}
                            label="Session Max"
                            value={fmt(policy.session.ssoSessionMaxLifespan)}
                        />
                        <PolicyCard
                            icon={Lock}
                            label="Password"
                            value={policy.password.raw || 'Default'}
                        />
                        <PolicyCard
                            icon={Fingerprint}
                            label="MFA"
                            value={policy.mfa.otpPolicyType || 'N/A'}
                        />
                        <PolicyCard
                            icon={Shield}
                            label="Brute Force"
                            value={policy.bruteForce.enabled
                                ? `On (${policy.bruteForce.failureFactor} attempts)`
                                : 'Off'}
                            variant={policy.bruteForce.enabled ? 'default' : 'destructive'}
                        />
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">Failed to load policy.</p>
                )}
            </section>

            <Separator />

            {/* ── Active Sessions ─────────────────────────────── */}
            <section className="space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <h3 className="font-medium">Active Sessions</h3>
                        <Badge variant="secondary">{sessions.length}</Badge>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
                            <RefreshCw className={`size-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                        {sessions.length > 0 && (
                            <Button
                                variant="destructive"
                                size="sm"
                                disabled={revoking === 'all'}
                                onClick={() => setConfirmDialog({
                                    open: true,
                                    title: 'Revoke All Sessions',
                                    description: 'This will log out ALL users immediately. Are you sure?',
                                    onConfirm: () => {
                                        setConfirmDialog(prev => ({ ...prev, open: false }));
                                        revokeAllSessions();
                                    },
                                })}
                            >
                                <Trash2 className="size-4 mr-2" />
                                Revoke All
                            </Button>
                        )}
                    </div>
                </div>

                {loading ? (
                    <div className="space-y-2">
                        {[...Array(3)].map((_, i) => (
                            <Skeleton key={i} className="h-14 w-full" />
                        ))}
                    </div>
                ) : sessions.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center py-12">
                        <div className="text-center">
                            <Globe className="size-12 mx-auto mb-3 opacity-20" />
                            <p className="text-lg mb-2">No active sessions</p>
                            <p className="text-sm text-muted-foreground">
                                All users are currently logged out.
                            </p>
                        </div>
                    </div>
                ) : (
                    <Card>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>User</TableHead>
                                    <TableHead>IP Address</TableHead>
                                    <TableHead>Started</TableHead>
                                    <TableHead>Last Activity</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sessions.map(s => (
                                    <TableRow key={s.id}>
                                        <TableCell>
                                            <div className="font-medium text-sm">{s.username}</div>
                                            <div className="text-xs text-muted-foreground">{s.email}</div>
                                        </TableCell>
                                        <TableCell className="font-mono text-sm">{s.ipAddress}</TableCell>
                                        <TableCell className="text-sm">{fmtDate(s.start)}</TableCell>
                                        <TableCell className="text-sm">{fmtDate(s.lastAccess)}</TableCell>
                                        <TableCell className="text-right">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:text-destructive"
                                                disabled={revoking === s.id}
                                                onClick={() => setConfirmDialog({
                                                    open: true,
                                                    title: 'Revoke Session',
                                                    description: `Revoke session for ${s.username || s.email}? They will be logged out.`,
                                                    onConfirm: () => {
                                                        setConfirmDialog(prev => ({ ...prev, open: false }));
                                                        revokeSession(s.id);
                                                    },
                                                })}
                                            >
                                                <Trash2 className="size-4 mr-1" />
                                                Revoke
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </Card>
                )}
            </section>

            {/* ── Confirm Dialog ──────────────────────────────── */}
            <Dialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, open }))}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{confirmDialog.title}</DialogTitle>
                        <DialogDescription>{confirmDialog.description}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmDialog(prev => ({ ...prev, open: false }))}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={confirmDialog.onConfirm}>
                            Confirm
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/* ── Sub-component ─────────────────────────────────────────────────────────── */

function PolicyCard({ icon: Icon, label, value, variant }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    variant?: 'default' | 'destructive';
}) {
    return (
        <Card>
            <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
                </div>
                <div className="text-sm font-semibold">
                    {variant === 'destructive'
                        ? <Badge variant="destructive">{value}</Badge>
                        : value}
                </div>
            </CardContent>
        </Card>
    );
}

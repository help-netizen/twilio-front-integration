import { useState, useEffect } from 'react';
import { authedFetch } from '../services/apiClient';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { toast } from 'sonner';
import { Shield, Key, Users, Settings, ExternalLink, RefreshCw, Trash2, Globe, Clock, Lock, Fingerprint } from 'lucide-react';
import { fmt, fmtDate, PolicyCard } from './SuperAdminHelpers';
import type { SessionInfo, AuthPolicy } from './SuperAdminHelpers';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CompaniesManager } from '../components/super-admin/CompaniesManager';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const KC_URL = import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const KC_REALM = import.meta.env.VITE_KEYCLOAK_REALM || 'crm-prod';

const quickLinks = [
    { icon: Key, title: 'Keycloak Admin Console', description: 'Realms, users, clients, identity settings', href: `${KC_URL}/admin/master/console` },
    { icon: Users, title: 'User Management', description: `Manage users in ${KC_REALM}`, href: `${KC_URL}/admin/master/console/#/${KC_REALM}/users` },
    { icon: Settings, title: 'Realm Settings', description: 'Token lifespans, login, email config', href: `${KC_URL}/admin/master/console/#/${KC_REALM}/realm-settings` },
];

export default function SuperAdminPage() {
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [policy, setPolicy] = useState<AuthPolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [revoking, setRevoking] = useState<string | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({ open: false, title: '', description: '', onConfirm: () => { } });

    const fetchData = async () => {
        setLoading(true);
        try { 
            const [sR, pR] = await Promise.all([authedFetch(`${API_BASE}/admin/sessions`), authedFetch(`${API_BASE}/admin/sessions/auth-policy`)]); 
            if (sR.ok) { const d = await sR.json(); setSessions(d.sessions || []); } else toast.error('Failed to load sessions'); 
            if (pR.ok) { const d = await pR.json(); setPolicy(d.policy || null); } else toast.error('Failed to load auth policy'); 
        }
        catch (e: any) { toast.error('Connection error', { description: e.message }); } finally { setLoading(false); }
    };

    useEffect(() => { fetchData(); }, []);

    const revokeSession = async (sessionId: string) => { setRevoking(sessionId); try { const r = await authedFetch(`${API_BASE}/admin/sessions/${sessionId}`, { method: 'DELETE' }); if (r.ok) { setSessions(p => p.filter(s => s.id !== sessionId)); toast.success('Session revoked'); } else toast.error('Failed to revoke session'); } catch { toast.error('Failed to revoke session'); } setRevoking(null); };
    const revokeAllSessions = async () => { setRevoking('all'); try { const userIds = [...new Set(sessions.map(s => s.userId))]; await Promise.all(userIds.map(uid => authedFetch(`${API_BASE}/admin/sessions/user/${uid}`, { method: 'DELETE' }))); setSessions([]); toast.success('All sessions revoked'); } catch { toast.error('Failed to revoke sessions'); } setRevoking(null); };

    return (
        <div className="max-w-6xl mx-auto p-6 space-y-6">
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <Shield className="size-6 text-primary" />
                    <h2 className="text-2xl font-bold tracking-tight">Super Admin Platform</h2>
                </div>
                <p className="text-sm text-muted-foreground">Manage the Blanc platform, tenant companies, and global security policies.</p>
            </div>

            <Tabs defaultValue="companies" className="w-full">
                <TabsList className="grid w-full grid-cols-3 max-w-md mb-8">
                    <TabsTrigger value="companies">Companies</TabsTrigger>
                    <TabsTrigger value="sessions">Sessions</TabsTrigger>
                    <TabsTrigger value="policy">Auth Policy</TabsTrigger>
                </TabsList>
                
                <TabsContent value="companies" className="space-y-6">
                    <div className="flex flex-col space-y-2 mb-4">
                        <h3 className="text-lg font-medium">Platform Tenants</h3>
                        <p className="text-sm text-muted-foreground">Manage the lifecycle of customer workspaces and bootstrap initial administrators.</p>
                    </div>
                    <CompaniesManager />
                </TabsContent>
                
                <TabsContent value="sessions" className="space-y-6">
                    <div className="flex flex-col space-y-2 mb-4">
                        <h3 className="text-lg font-medium">Identity & Sessions</h3>
                        <p className="text-sm text-muted-foreground">Monitor and manage active SSO sessions across all companies.</p>
                    </div>
                    <section className="space-y-4">
                        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><h3 className="font-medium">Active Sessions</h3><Badge variant="secondary">{sessions.length}</Badge></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={fetchData} disabled={loading}><RefreshCw className={`size-4 mr-2 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>{sessions.length > 0 && <Button variant="destructive" size="sm" disabled={revoking === 'all'} onClick={() => setConfirmDialog({ open: true, title: 'Revoke All Sessions', description: 'This will log out ALL users immediately. Are you sure?', onConfirm: () => { setConfirmDialog(p => ({ ...p, open: false })); revokeAllSessions(); } })}><Trash2 className="size-4 mr-2" />Revoke All</Button>}</div></div>
                        {loading ? <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div> : sessions.length === 0 ? <div className="flex-1 flex items-center justify-center py-12"><div className="text-center"><Globe className="size-12 mx-auto mb-3 opacity-20" /><p className="text-lg mb-2">No active sessions</p><p className="text-sm text-muted-foreground">All users are currently logged out.</p></div></div> : (
                            <Card><Table><TableHeader><TableRow><TableHead>User</TableHead><TableHead>IP Address</TableHead><TableHead>Started</TableHead><TableHead>Last Activity</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{sessions.map(s => <TableRow key={s.id}><TableCell><div className="font-medium text-sm">{s.username}</div><div className="text-xs text-muted-foreground">{s.email}</div></TableCell><TableCell className="font-mono text-sm">{s.ipAddress}</TableCell><TableCell className="text-sm">{fmtDate(s.start)}</TableCell><TableCell className="text-sm">{fmtDate(s.lastAccess)}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={revoking === s.id} onClick={() => setConfirmDialog({ open: true, title: 'Revoke Session', description: `Revoke session for ${s.username || s.email}? They will be logged out.`, onConfirm: () => { setConfirmDialog(p => ({ ...p, open: false })); revokeSession(s.id); } })}><Trash2 className="size-4 mr-1" />Revoke</Button></TableCell></TableRow>)}</TableBody></Table></Card>
                        )}
                    </section>
                </TabsContent>
                
                <TabsContent value="policy" className="space-y-6">
                    <div className="flex flex-col space-y-2 mb-4">
                        <h3 className="text-lg font-medium">Global Authentication Policy</h3>
                        <p className="text-sm text-muted-foreground">Security constraints pulled dynamically from the underlying Keycloak realm.</p>
                    </div>
                    <section className="space-y-3">
                        <h3 className="font-medium">Quick Links</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            {quickLinks.map(link => <a key={link.title} href={link.href} target="_blank" rel="noopener noreferrer" className="group block"><Card className="h-full transition-colors hover:border-primary/40"><CardHeader className="pb-2"><div className="flex items-center justify-between"><link.icon className="size-4 text-muted-foreground" /><ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" /></div><CardTitle className="text-sm">{link.title}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{link.description}</p></CardContent></Card></a>)}
                        </div>
                    </section>
                    <Separator />
                    <section className="space-y-3">
                        {loading ? <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div> : policy ? <div className="grid grid-cols-2 sm:grid-cols-3 gap-3"><PolicyCard icon={Clock} label="Access Token" value={fmt(policy.session.accessTokenLifespan)} /><PolicyCard icon={Clock} label="Session Idle" value={fmt(policy.session.ssoSessionIdleTimeout)} /><PolicyCard icon={Clock} label="Session Max" value={fmt(policy.session.ssoSessionMaxLifespan)} /><PolicyCard icon={Lock} label="Password" value={policy.password.raw || 'Default'} /><PolicyCard icon={Fingerprint} label="MFA" value={policy.mfa.otpPolicyType || 'N/A'} /><PolicyCard icon={Shield} label="Brute Force" value={policy.bruteForce.enabled ? `On (${policy.bruteForce.failureFactor} attempts)` : 'Off'} variant={policy.bruteForce.enabled ? 'default' : 'destructive'} /></div> : <p className="text-sm text-muted-foreground">Failed to load policy.</p>}
                    </section>
                </TabsContent>
            </Tabs>

            <Dialog open={confirmDialog.open} onOpenChange={open => setConfirmDialog(p => ({ ...p, open }))}><DialogContent><DialogHeader><DialogTitle>{confirmDialog.title}</DialogTitle><DialogDescription>{confirmDialog.description}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmDialog(p => ({ ...p, open: false }))}>Cancel</Button><Button variant="destructive" onClick={confirmDialog.onConfirm}>Confirm</Button></DialogFooter></DialogContent></Dialog>
        </div>
    );
}

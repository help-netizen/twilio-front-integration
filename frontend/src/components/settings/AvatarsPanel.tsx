import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import { ConnectAvatarWizard, baseLabel, type AvatarBase } from './ConnectAvatarWizard';
import {
    connectMyAvatar,
    disconnectMyAvatar,
    fetchAvatars,
    setMyAvatarSends,
    setMyAvatarWrites,
    type AvatarBaseModel,
    type MyAvatar,
    type RosterAvatar,
} from '../../services/avatarsApi';

const MCP_SERVER_URL = 'https://api.albusto.com/mcp/chatgpt';
const OAUTH_AUTH_URL = 'https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/auth';
const OAUTH_TOKEN_URL = 'https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/token';
const OAUTH_SERVER_BASE = 'https://auth.albusto.com/realms/crm-prod';
/** OAuth client per base — same Keycloak realm, one pre-registered client each. */
const OAUTH_CLIENT_ID: Record<AvatarBaseModel, string> = {
    chatgpt: 'chatgpt-crm-mcp',
    claude: 'claude-crm-mcp',
};
const scopeFor = (a: MyAvatar | null) =>
    a?.sends_enabled ? 'albusto.mcp.read albusto.mcp.write albusto.mcp.send'
        : a?.writes_enabled ? 'albusto.mcp.read albusto.mcp.write'
            : 'albusto.mcp.read';

interface AvatarsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The signed-in user's display name, for "Avatar of <name>". */
    myName: string;
    companyName: string;
}

function initials(name: string) {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return (parts.map(p => p[0]).join('') || '?').toUpperCase();
}

function CopyRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 rounded-[10px] bg-[var(--blanc-field)] px-3.5 py-2.5">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--blanc-ink-3)]">{label}</div>
                <code className="block truncate font-mono text-xs text-[var(--blanc-ink-1)]">{value}</code>
            </div>
            <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${label}`}
                className="shrink-0 text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)]"
                onClick={() => { navigator.clipboard.writeText(value); toast.success(`${label} copied`); }}>
                <Copy className="h-4 w-4" />
            </Button>
        </div>
    );
}

function RosterRow({ a }: { a: RosterAvatar }) {
    return (
        <div className="flex items-center gap-3 border-t border-[var(--blanc-line)] py-2.5 first:border-t-0">
            <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#b9b9bd,#9a9aa0)] text-xs font-bold text-white"
                style={{ fontFamily: 'var(--blanc-font-heading)' }} aria-hidden>
                {initials(a.owner_name)}
            </div>
            <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--blanc-ink-1)]">
                    Avatar of {a.owner_name}{a.is_me && <span className="ml-1 text-[var(--blanc-ink-3)]">· you</span>}
                </div>
                <div className="text-xs text-[var(--blanc-ink-3)]">{baseLabel((a.base ?? 'chatgpt') as AvatarBase)}</div>
            </div>
            <span className={`ml-auto text-xs ${a.presence === 'active' ? 'text-[var(--blanc-task)]' : 'text-[var(--blanc-ink-3)]'}`}>
                {a.presence === 'active' ? '● active' : 'idle'}
            </span>
        </div>
    );
}

export function AvatarsPanel({ open, onOpenChange, myName, companyName }: AvatarsPanelProps) {
    const queryClient = useQueryClient();
    const [view, setView] = useState<'hub' | 'wizard' | 'connect'>('hub');
    const [connectBase, setConnectBase] = useState<AvatarBaseModel>('chatgpt');
    const [confirmWrites, setConfirmWrites] = useState(false);
    const [confirmSends, setConfirmSends] = useState(false);

    const q = useQuery({
        queryKey: ['avatars'],
        queryFn: fetchAvatars,
        enabled: open,
        refetchOnMount: 'always',
        retry: false,
    });
    const me = q.data?.me ?? null;
    const connected = me?.connected === true;

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['avatars'] });
    const writesMut = useMutation({
        mutationFn: setMyAvatarWrites,
        onSuccess: (_d, enabled) => { invalidate(); setConfirmWrites(false); toast.success(enabled ? 'Changes enabled' : 'Changes disabled'); },
        onError: (e: Error) => toast.error(e.message || 'Failed to update'),
    });
    const sendsMut = useMutation({
        mutationFn: setMyAvatarSends,
        onSuccess: (_d, enabled) => { invalidate(); setConfirmSends(false); toast.success(enabled ? 'Customer sends enabled' : 'Customer sends disabled'); },
        onError: (e: Error) => toast.error(e.message || 'Failed to update'),
    });
    const disconnectMut = useMutation({
        mutationFn: disconnectMyAvatar,
        onSuccess: () => { invalidate(); toast.success('Avatar disconnected'); },
        onError: (e: Error) => toast.error(e.message || 'Failed to disconnect'),
    });
    // Pre-provision the caller's own binding on the chosen base before its OAuth steps.
    const connectMut = useMutation({
        mutationFn: (base: AvatarBaseModel) => connectMyAvatar(base),
        onSuccess: () => { invalidate(); setView('connect'); },
        onError: (e: Error) => toast.error(e.message || 'Could not start the connection'),
    });

    const title = view === 'wizard' ? 'New avatar' : view === 'connect' ? `Connect in ${baseLabel(connectBase)}` : 'Avatars';
    const eyebrow = view === 'hub' ? 'Marketplace' : 'Connect your avatar';

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) setView('hub'); onOpenChange(o); }}>
            <DialogContent variant="panel">
                <DialogPanelHeader className="md:px-8 md:pt-7">
                    <div className="blanc-eyebrow">{eyebrow}</div>
                    <DialogTitle className="text-2xl font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}>
                        {title}
                    </DialogTitle>
                    <DialogDescription>
                        {view === 'hub'
                            ? 'Your AI avatar acts in Albusto as your digital copy — with your access, never more. Every action is logged as your avatar.'
                            : 'A digital copy of you that works inside Albusto with your access.'}
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px]">
                        {q.isLoading ? (
                            <div className="flex items-center gap-2 text-sm text-[var(--blanc-ink-3)]">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading avatars…
                            </div>
                        ) : q.isError ? (
                            <div className="space-y-3">
                                <p className="text-sm text-[var(--blanc-danger)]">Avatars could not be loaded.</p>
                                <Button variant="outline" onClick={() => q.refetch()}>Try again</Button>
                            </div>
                        ) : !q.data?.installation_enabled ? (
                            <div className="rounded-xl bg-[var(--blanc-surface-muted)] px-4 py-4 text-sm text-[var(--blanc-ink-2)]">
                                Avatars aren’t enabled for {companyName} yet. Ask a company admin to enable them in
                                Settings → Integrations → Marketplace.
                            </div>
                        ) : view === 'wizard' ? (
                            <ConnectAvatarWizard
                                onCancel={() => setView('hub')}
                                onContinue={({ base }) => { setConnectBase(base as AvatarBaseModel); connectMut.mutate(base as AvatarBaseModel); }}
                            />
                        ) : view === 'connect' ? (
                            <div className="space-y-6">
                                <ol className="space-y-4">
                                    {connectBase === 'claude' ? (
                                        <>
                                            <li className="text-sm text-[var(--blanc-ink-2)]"><strong className="text-[var(--blanc-ink-1)]">1.</strong> On a computer, open <strong>Claude → Settings → Connectors → Add custom connector</strong>.</li>
                                            <li><CopyRow label="MCP server URL" value={MCP_SERVER_URL} /></li>
                                            <li className="text-sm text-[var(--blanc-ink-2)]"><strong className="text-[var(--blanc-ink-1)]">2.</strong> Open <strong>Advanced settings</strong> and set the <strong>OAuth Client ID</strong> (leave Client secret empty). Claude finds the rest automatically; if it asks, use the values below.</li>
                                            <li><CopyRow label="Client ID" value={OAUTH_CLIENT_ID.claude} /></li>
                                        </>
                                    ) : (
                                        <>
                                            <li className="text-sm text-[var(--blanc-ink-2)]"><strong className="text-[var(--blanc-ink-1)]">1.</strong> On a computer, open chatgpt.com → enable <strong>Developer mode</strong> (Settings), then add a connector at <strong>chatgpt.com/plugins</strong>.</li>
                                            <li><CopyRow label="MCP server URL" value={MCP_SERVER_URL} /></li>
                                            <li className="text-sm text-[var(--blanc-ink-2)]"><strong className="text-[var(--blanc-ink-1)]">2.</strong> Choose <strong>OAuth</strong>, leave <strong>Registration URL empty</strong>. If it asks for OAuth details, use the values below (Client secret empty, token auth <strong>none</strong>).</li>
                                            <li><CopyRow label="Client ID" value={OAUTH_CLIENT_ID.chatgpt} /></li>
                                        </>
                                    )}
                                    <li><CopyRow label="Authorization URL" value={OAUTH_AUTH_URL} /></li>
                                    <li><CopyRow label="Token URL" value={OAUTH_TOKEN_URL} /></li>
                                    <li><CopyRow label="Authorization server base" value={OAUTH_SERVER_BASE} /></li>
                                    <li><CopyRow label="Resource" value={MCP_SERVER_URL} /></li>
                                    <li><CopyRow label="Scope" value={scopeFor(me)} /></li>
                                    <li className="text-sm text-[var(--blanc-ink-2)]"><strong className="text-[var(--blanc-ink-1)]">3.</strong> Sign in with <strong>your own</strong> Albusto account, then start using the connector in a chat.</li>
                                </ol>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">Your avatar</div>
                                    {connected ? (
                                        <div className="rounded-xl bg-[var(--blanc-field)] p-4">
                                            <div className="flex items-center gap-3">
                                                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#7f42e1,#a37bec)] text-[15px] font-bold text-white"
                                                    style={{ fontFamily: 'var(--blanc-font-heading)' }} aria-hidden>{initials(myName)}</div>
                                                <div className="min-w-0">
                                                    <div className="text-base font-semibold text-[var(--blanc-ink-1)]">Avatar of {myName}</div>
                                                    <div className="text-sm text-[var(--blanc-ink-2)]">Based on {baseLabel((me?.base ?? 'chatgpt') as AvatarBase)} · via {baseLabel((me?.base ?? 'chatgpt') as AvatarBase)} (MCP)</div>
                                                </div>
                                                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-[rgba(27,139,99,0.12)] px-2.5 py-1 text-xs font-semibold text-[var(--blanc-task)]">
                                                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--blanc-task)]" /> Active
                                                </span>
                                            </div>
                                            <div className="mt-3 flex gap-2.5 rounded-xl bg-[var(--blanc-accent-soft)] px-3 py-2.5 text-sm text-[var(--blanc-accent-ink,#5b2bb0)]">
                                                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                                                <div><strong>Inherits your access.</strong> It can do exactly what your role allows — no more. Change roles or leave, and it loses access with you.</div>
                                            </div>

                                            <div className="mt-3.5">
                                                <div className="flex items-start justify-between gap-4 border-t border-[var(--blanc-line)] py-3">
                                                    <div><div className="text-sm font-semibold text-[var(--blanc-ink-1)]">Make changes</div><div className="mt-0.5 text-sm text-[var(--blanc-ink-2)]">Create & edit leads, jobs, notes, estimates, invoices — within your access.</div></div>
                                                    <Switch checked={me?.writes_enabled === true} disabled={writesMut.isPending} aria-label="Make changes"
                                                        onCheckedChange={(v) => v ? setConfirmWrites(true) : writesMut.mutate(false)} />
                                                </div>
                                                <div className="flex items-start justify-between gap-4 border-t border-[var(--blanc-line)] py-3">
                                                    <div><div className="text-sm font-semibold text-[var(--blanc-ink-1)]">Send to customers</div><div className="mt-0.5 text-sm text-[var(--blanc-ink-2)]">Email or text estimates & invoices to the contact on a record — never an address it picks.</div></div>
                                                    <Switch checked={me?.sends_enabled === true} disabled={sendsMut.isPending} aria-label="Send to customers"
                                                        onCheckedChange={(v) => v ? setConfirmSends(true) : sendsMut.mutate(false)} />
                                                </div>
                                            </div>

                                            {(me?.writes_enabled || me?.sends_enabled) && (
                                                <div className="mt-3 space-y-2">
                                                    <p className="text-sm text-[var(--blanc-ink-2)]">Update the connector’s <strong>Scope</strong> in {baseLabel((me?.base ?? 'chatgpt') as AvatarBase)} and re-connect:</p>
                                                    <CopyRow label="Scope" value={scopeFor(me)} />
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="rounded-xl bg-[var(--blanc-field)] p-5 text-center">
                                            <p className="text-sm text-[var(--blanc-ink-2)]">You don’t have an avatar yet — an AI copy of you (ChatGPT or Claude) that works in Albusto with your access.</p>
                                            <Button className="mt-3.5" onClick={() => setView('wizard')}>Connect your Avatar</Button>
                                        </div>
                                    )}
                                </section>

                                {(q.data?.roster?.length ?? 0) > 0 && (
                                    <section className="space-y-3.5">
                                        <div className="blanc-eyebrow">Avatars in {companyName}</div>
                                        <div>{q.data!.roster.map(a => <RosterRow key={a.owner_user_id} a={a} />)}</div>
                                    </section>
                                )}
                            </div>
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    {view !== 'hub' ? (
                        <Button variant="ghost" onClick={() => setView('hub')}>Back</Button>
                    ) : connected ? (
                        <Button variant="ghost" className="text-[var(--blanc-danger)] hover:bg-[rgba(240,80,63,0.08)] hover:text-[var(--blanc-danger)]"
                            onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending}>Disconnect</Button>
                    ) : <span />}
                    <span className="flex-1" />
                    <Button type="button" onClick={() => (view === 'connect' ? setView('hub') : onOpenChange(false))}>Done</Button>
                </DialogPanelFooter>
            </DialogContent>

            <Dialog open={confirmWrites} onOpenChange={setConfirmWrites}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Let your avatar make changes?</DialogTitle>
                        <DialogDescription>Within your own access, it can create and edit leads, jobs, notes, estimates and invoices. ChatGPT confirms each change; everything is logged as your avatar. Turn off anytime.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmWrites(false)}>Cancel</Button>
                        <Button onClick={() => writesMut.mutate(true)} disabled={writesMut.isPending}>{writesMut.isPending ? 'Enabling…' : 'Enable'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={confirmSends} onOpenChange={setConfirmSends}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Let your avatar send to customers?</DialogTitle>
                        <DialogDescription>It can email or text estimates and invoices to the contact already on a record — never an address it chooses — and only if you can send them. ChatGPT confirms each send; all are logged. Turn off anytime.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmSends(false)}>Cancel</Button>
                        <Button onClick={() => sendsMut.mutate(true)} disabled={sendsMut.isPending}>{sendsMut.isPending ? 'Enabling…' : 'Enable'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Dialog>
    );
}

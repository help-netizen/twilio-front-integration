import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
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
import { Switch } from '../ui/switch';
import {
    fetchChatgptMcpWriteSettings,
    setChatgptMcpWrites,
    setChatgptMcpSends,
    type MarketplaceApp,
} from '../../services/marketplaceApi';

const WRITE_SCOPE_VALUE = 'albusto.mcp.read albusto.mcp.write';
const SEND_SCOPE_VALUE = 'albusto.mcp.read albusto.mcp.write albusto.mcp.send';

const MCP_SERVER_URL = 'https://api.albusto.com/mcp/chatgpt';
const OAUTH_AUTH_URL = 'https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/auth';
const OAUTH_TOKEN_URL = 'https://auth.albusto.com/realms/crm-prod/protocol/openid-connect/token';
const OAUTH_SERVER_BASE = 'https://auth.albusto.com/realms/crm-prod';
const OAUTH_CLIENT_ID = 'chatgpt-crm-mcp';
const OAUTH_SCOPE = 'albusto.mcp.read';

interface ChatgptMcpConnectPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    app: MarketplaceApp | null;
    onDisconnect: () => void;
}

function copyValue(value: string, label: string) {
    navigator.clipboard.writeText(value);
    toast.success(`${label} copied to clipboard`);
}

function CopyRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 rounded-[10px] bg-[var(--blanc-field)] px-3.5 py-2.5">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--blanc-ink-3)]">{label}</div>
                <code className="block truncate font-mono text-xs text-[var(--blanc-ink-1)]">{value}</code>
            </div>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Copy ${label}`}
                className="shrink-0 text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)]"
                onClick={() => copyValue(value, label)}
            >
                <Copy className="h-4 w-4" />
            </Button>
        </div>
    );
}

function StaticRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-[10px] bg-[var(--blanc-field)] px-3.5 py-2.5">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--blanc-ink-3)]">{label}</div>
            <div className="text-xs text-[var(--blanc-ink-1)]">{value}</div>
        </div>
    );
}

function Step({ index, title, children }: { index: number; title: string; children?: React.ReactNode }) {
    return (
        <li className="relative pl-10">
            <span
                aria-hidden
                className="absolute left-0 top-0 grid h-[26px] w-[26px] place-items-center rounded-full bg-[var(--blanc-accent)] text-xs font-bold text-white"
                style={{ fontFamily: 'var(--blanc-font-heading)' }}
            >
                {index}
            </span>
            <div className="text-sm font-semibold text-[var(--blanc-ink-1)]">{title}</div>
            {children && <div className="mt-1 space-y-2 text-sm text-[var(--blanc-ink-2)]">{children}</div>}
        </li>
    );
}

export function ChatgptMcpConnectPanel({ open, onOpenChange, app, onDisconnect }: ChatgptMcpConnectPanelProps) {
    const connected = app?.installation?.status === 'connected';
    const accessItems = app
        ? (app.access_summary.length ? app.access_summary : app.requested_scopes)
        : [];
    const queryClient = useQueryClient();
    const [confirmWritesOpen, setConfirmWritesOpen] = useState(false);
    const [confirmSendsOpen, setConfirmSendsOpen] = useState(false);

    const writeSettingsQuery = useQuery({
        queryKey: ['chatgpt-mcp-write-settings'],
        queryFn: fetchChatgptMcpWriteSettings,
        enabled: open && connected,
        refetchOnMount: 'always',
        retry: false,
    });
    const writesEnabled = writeSettingsQuery.data?.settings.writes_enabled === true;
    const sendsEnabled = writeSettingsQuery.data?.settings.sends_enabled === true;

    const writesMutation = useMutation({
        mutationFn: setChatgptMcpWrites,
        onSuccess: (_data, enabled) => {
            queryClient.invalidateQueries({ queryKey: ['chatgpt-mcp-write-settings'] });
            setConfirmWritesOpen(false);
            toast.success(enabled ? 'Write access enabled' : 'Write access disabled');
        },
        onError: (err: Error) => toast.error(err.message || 'Failed to update write access'),
    });

    const sendsMutation = useMutation({
        mutationFn: setChatgptMcpSends,
        onSuccess: (_data, enabled) => {
            queryClient.invalidateQueries({ queryKey: ['chatgpt-mcp-write-settings'] });
            setConfirmSendsOpen(false);
            toast.success(enabled ? 'Customer sends enabled' : 'Customer sends disabled');
        },
        onError: (err: Error) => toast.error(err.message || 'Failed to update send access'),
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader className="md:px-8 md:pt-7">
                    <div className="blanc-eyebrow">Marketplace agent</div>
                    <DialogTitle
                        className="text-2xl font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        ChatGPT CRM Connector
                    </DialogTitle>
                    <DialogDescription>
                        Let ChatGPT read your company&apos;s CRM through a dedicated, read-only AI dispatcher.
                    </DialogDescription>
                    {connected && (
                        <span className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-[rgba(27,139,99,0.12)] px-2.5 py-1 text-xs font-semibold text-[var(--blanc-task)]">
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--blanc-task)]" />
                            AI dispatcher active
                        </span>
                    )}
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <section className="space-y-3.5">
                            <div className="blanc-eyebrow">Connect in ChatGPT</div>
                            <ol className="space-y-4">
                                <Step index={1} title="Turn on Developer mode">
                                    <p>
                                        On a computer, open chatgpt.com → Settings and enable <strong>Developer mode</strong>.
                                        It is required for custom MCP connectors and is not available in the mobile app.
                                    </p>
                                </Step>
                                <Step index={2} title="Add the connector">
                                    <p>
                                        Open <strong>chatgpt.com/plugins</strong>, create a new connector, and paste the MCP server URL:
                                    </p>
                                    <CopyRow label="MCP server URL" value={MCP_SERVER_URL} />
                                </Step>
                                <Step index={3} title="Choose OAuth authentication">
                                    <p>
                                        Pick <strong>OAuth</strong>. Most fields are discovered automatically — if the form asks,
                                        use the values from the section below and leave <strong>Registration URL empty</strong>.
                                    </p>
                                </Step>
                                <Step index={4} title="Connect and sign in">
                                    <p>
                                        Press Connect and sign in with the <strong>same Albusto admin account</strong> that
                                        enabled this app here. Your company is resolved automatically.
                                    </p>
                                </Step>
                                <Step index={5} title="Mention it in a chat">
                                    <p>
                                        In a ChatGPT conversation, mention the connector by the name you gave it — for example{' '}
                                        <code className="rounded bg-[var(--blanc-field)] px-1.5 py-0.5 font-mono text-xs">@Albusto MCP</code>{' '}
                                        — and ask about your jobs, leads, or schedule.
                                    </p>
                                </Step>
                            </ol>
                        </section>

                        <section className="space-y-3.5">
                            <div className="blanc-eyebrow">OAuth values (if the form asks)</div>
                            <div className="space-y-2">
                                <CopyRow label="Client ID" value={OAUTH_CLIENT_ID} />
                                <CopyRow label="Authorization URL" value={OAUTH_AUTH_URL} />
                                <CopyRow label="Token URL" value={OAUTH_TOKEN_URL} />
                                <CopyRow label="Authorization server base" value={OAUTH_SERVER_BASE} />
                                <CopyRow label="Resource" value={MCP_SERVER_URL} />
                                <CopyRow label="Scope" value={OAUTH_SCOPE} />
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                    <StaticRow label="Client secret" value="Leave empty" />
                                    <StaticRow label="Token endpoint auth" value="none" />
                                    <StaticRow label="Registration URL" value="Leave empty" />
                                </div>
                            </div>
                        </section>

                        <section className="space-y-3.5">
                            <div className="blanc-eyebrow">What ChatGPT can read</div>
                            {accessItems.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {accessItems.map(item => (
                                        <span
                                            key={item}
                                            className="rounded-full border border-[var(--blanc-line)] bg-[var(--blanc-surface-muted)] px-3 py-1 text-xs text-[var(--blanc-ink-2)]"
                                        >
                                            {item}
                                        </span>
                                    ))}
                                </div>
                            )}
                            <div className="rounded-xl bg-[var(--blanc-surface-muted)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]">
                                Only a company admin can connect or disconnect this app, and disconnecting cuts off
                                access immediately, even for tokens that have not expired yet.
                            </div>
                        </section>

                        {connected && (
                            <section className="space-y-3.5">
                                <div className="blanc-eyebrow">Writes</div>
                                <div className="flex items-start justify-between gap-5 rounded-xl bg-[var(--blanc-field)] px-4 py-4">
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold text-[var(--blanc-ink-1)]">
                                            Allow ChatGPT to make changes
                                        </div>
                                        <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">
                                            Create and edit leads, jobs, and notes as the AI dispatcher. Every change is
                                            confirmed in ChatGPT before it runs and logged here. Turning this off cuts
                                            write access instantly.
                                        </p>
                                    </div>
                                    {writeSettingsQuery.isLoading ? (
                                        <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-[var(--blanc-ink-3)]" />
                                    ) : (
                                        <Switch
                                            checked={writesEnabled}
                                            disabled={writeSettingsQuery.isError || writesMutation.isPending}
                                            aria-label="Allow ChatGPT to make changes"
                                            onCheckedChange={value => {
                                                if (value) setConfirmWritesOpen(true);
                                                else writesMutation.mutate(false);
                                            }}
                                        />
                                    )}
                                </div>
                                {writeSettingsQuery.isError && (
                                    <p className="text-xs text-[var(--blanc-ink-3)]">
                                        Write-access status is unavailable right now.
                                    </p>
                                )}
                                {writesEnabled && !sendsEnabled && (
                                    <div className="space-y-2">
                                        <p className="text-sm text-[var(--blanc-ink-2)]">
                                            To activate writes, update the connector&apos;s <strong>Scope</strong> in
                                            ChatGPT and re-connect:
                                        </p>
                                        <CopyRow label="Scope" value={WRITE_SCOPE_VALUE} />
                                    </div>
                                )}
                            </section>
                        )}

                        {connected && (
                            <section className="space-y-3.5">
                                <div className="blanc-eyebrow">Customer sends</div>
                                <div className="flex items-start justify-between gap-5 rounded-xl bg-[var(--blanc-field)] px-4 py-4">
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold text-[var(--blanc-ink-1)]">
                                            Allow ChatGPT to send to customers
                                        </div>
                                        <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">
                                            Email or text estimates and invoices to the customer on a job. ChatGPT can
                                            only send to the contact already on the record — never an address it picks —
                                            and confirms each send first. Turning this off stops sends instantly.
                                        </p>
                                    </div>
                                    {writeSettingsQuery.isLoading ? (
                                        <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-[var(--blanc-ink-3)]" />
                                    ) : (
                                        <Switch
                                            checked={sendsEnabled}
                                            disabled={writeSettingsQuery.isError || sendsMutation.isPending}
                                            aria-label="Allow ChatGPT to send to customers"
                                            onCheckedChange={value => {
                                                if (value) setConfirmSendsOpen(true);
                                                else sendsMutation.mutate(false);
                                            }}
                                        />
                                    )}
                                </div>
                                {sendsEnabled && (
                                    <div className="space-y-2">
                                        <p className="text-sm text-[var(--blanc-ink-2)]">
                                            To activate sends, update the connector&apos;s <strong>Scope</strong> in
                                            ChatGPT and re-connect:
                                        </p>
                                        <CopyRow label="Scope" value={SEND_SCOPE_VALUE} />
                                    </div>
                                )}
                            </section>
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    {connected && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="mr-auto text-[var(--blanc-danger)] hover:bg-[rgba(240,80,63,0.08)] hover:text-[var(--blanc-danger)]"
                            onClick={onDisconnect}
                        >
                            Disconnect
                        </Button>
                    )}
                    <Button type="button" onClick={() => onOpenChange(false)}>
                        Done
                    </Button>
                </DialogPanelFooter>
            </DialogContent>

            <Dialog open={confirmWritesOpen} onOpenChange={setConfirmWritesOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Allow ChatGPT to make changes?</DialogTitle>
                        <DialogDescription>
                            The AI dispatcher will be able to create and edit leads, jobs, and notes in your company.
                            ChatGPT asks you to confirm each change before it runs, and every action is logged. You can
                            turn this off at any time — access stops immediately.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmWritesOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => writesMutation.mutate(true)}
                            disabled={writesMutation.isPending}
                        >
                            {writesMutation.isPending ? 'Enabling…' : 'Enable writes'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={confirmSendsOpen} onOpenChange={setConfirmSendsOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Allow ChatGPT to send to customers?</DialogTitle>
                        <DialogDescription>
                            The AI dispatcher will be able to email or text estimates and invoices to the customer
                            already linked to a job — never an address it chooses. ChatGPT confirms each send first,
                            and every send is logged. You can turn this off at any time — sends stop immediately.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmSendsOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => sendsMutation.mutate(true)}
                            disabled={sendsMutation.isPending}
                        >
                            {sendsMutation.isPending ? 'Enabling…' : 'Enable sends'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Dialog>
    );
}

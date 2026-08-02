import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, MessageSquareText, Plus, Send, Wrench } from 'lucide-react';
import { useAuthz } from '../hooks/useAuthz';
import { Button } from '../components/ui/button';
import { FloatingField } from '../components/ui/floating-field';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogPanelHeader,
    DialogTitle,
} from '../components/ui/dialog';
import {
    AppStudioApiError,
    type AppStudioChat,
    type AppStudioMessage,
    type AppStudioVersion,
    createAppStudioChat,
    getAppStudioMessages,
    listAppStudioChats,
    listAppStudioVersions,
    sendAppStudioMessage,
} from '../services/appStudioApi';

export interface AppStudioProfile {
    name: string;
    description?: string;
    version?: AppStudioVersion;
}

export function canAccessAppStudio(roleKey?: string | null): boolean {
    return roleKey === 'tenant_admin';
}

export function appStudioVersionLabel(version: AppStudioVersion): string {
    const number = version.version_number.replace(/^builder-/, '');
    return `Version ${number} · ${version.status}`;
}

// What the draft actually returned when it ran against the sandbox. Without this
// the author only sees the bot's account of the app, never its output — and a
// draft that quietly returns nothing looks exactly like one that works.
export function appStudioSandboxResult(version: AppStudioVersion): string | null {
    const report = version.scanner_report as { dry_run?: { result?: unknown } } | undefined;
    const result = report?.dry_run?.result;
    if (result === undefined || result === null) return null;
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return text.trim() ? text.slice(0, 2000) : null;
}

function SandboxResult({ version }: { version: AppStudioVersion }) {
    const result = appStudioSandboxResult(version);
    if (!result) return null;
    return (
        <div
            data-testid="app-studio-sandbox-result"
            className="mt-3 rounded-xl px-3 py-2.5"
            style={{ background: 'var(--blanc-surface-muted)' }}
        >
            <div className="blanc-eyebrow">Sandbox result</div>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-[var(--blanc-ink-2)]">
                {result}
            </p>
        </div>
    );
}

export function AppStudioAccessDenied() {
    return (
        <div
            data-status="403"
            className="flex min-h-[420px] items-center justify-center px-6 text-center"
            style={{ color: 'var(--blanc-ink-1)' }}
        >
            <div className="max-w-sm space-y-2">
                <div className="blanc-eyebrow">403</div>
                <h2 className="text-2xl font-semibold">You don&apos;t have access here</h2>
                <p className="text-sm text-[var(--blanc-ink-2)]">
                    App Studio is available only to company admins.
                </p>
            </div>
        </div>
    );
}

function ProfileContent({ profile }: { profile: AppStudioProfile | null }) {
    if (!profile) {
        return (
            <div className="py-10 text-sm text-[var(--blanc-ink-2)]">
                Create a version to see the app profile.
            </div>
        );
    }
    return (
        <div className="space-y-6">
            <div className="space-y-2">
                <div className="blanc-eyebrow">App profile</div>
                <h2 className="text-2xl font-semibold">{profile.name}</h2>
                {profile.description && (
                    <p className="text-sm leading-6 text-[var(--blanc-ink-2)]">{profile.description}</p>
                )}
            </div>
            {profile.version && (
                <div className="space-y-3.5">
                    <div>
                        <div className="blanc-eyebrow">Version status</div>
                        <p className="mt-2 text-sm font-medium">{appStudioVersionLabel(profile.version)}</p>
                        <SandboxResult version={profile.version} />
                    </div>
                    {profile.version.tools.length > 0 && (
                        <div>
                            <div className="blanc-eyebrow">Tools</div>
                            <div className="mt-2 space-y-2">
                                {profile.version.tools.map(tool => (
                                    <div key={tool} className="flex items-center gap-2 text-sm text-[var(--blanc-ink-2)]">
                                        <Wrench className="size-3.5 text-[var(--blanc-ink-3)]" />
                                        <span>{tool}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

interface AppStudioWorkspaceProps {
    chats: AppStudioChat[];
    selectedChatId: string | null;
    messages: AppStudioMessage[];
    versions: AppStudioVersion[];
    profile: AppStudioProfile | null;
    loading: boolean;
    error?: string | null;
    quotaExhausted?: boolean;
    composer: string;
    creating?: boolean;
    sending?: boolean;
    profileOpen: boolean;
    onSelectChat: (chatId: string) => void;
    onNewApp: () => void;
    onComposerChange: (value: string) => void;
    onSend: () => void;
    onProfileOpenChange: (open: boolean) => void;
}

export function AppStudioWorkspace({
    chats,
    selectedChatId,
    messages,
    versions,
    profile,
    loading,
    error,
    quotaExhausted,
    composer,
    creating,
    sending,
    profileOpen,
    onSelectChat,
    onNewApp,
    onComposerChange,
    onSend,
    onProfileOpenChange,
}: AppStudioWorkspaceProps) {
    const versionsById = useMemo(
        () => new Map(versions.map(version => [version.id, version])),
        [versions],
    );

    return (
        <div className="flex h-full min-h-[560px] flex-col gap-6 px-5 py-6 text-[var(--blanc-ink-1)] md:px-7">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="blanc-eyebrow">Apps &amp; integrations</div>
                    <h1 className="mt-1 text-2xl font-semibold">App Studio</h1>
                    <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">
                        Describe a read-only app and refine each draft in its chat.
                    </p>
                </div>
                <Button onClick={onNewApp} disabled={creating}>
                    {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                    New app
                </Button>
            </div>

            {quotaExhausted && (
                <div className="rounded-2xl bg-[var(--blanc-accent-soft)] px-4 py-3 text-sm text-[var(--blanc-ink-1)]">
                    Today&apos;s App Studio generation quota is exhausted. Existing chats remain available.
                </div>
            )}

            {error ? (
                <div className="flex flex-1 items-center justify-center text-center">
                    <div className="max-w-sm space-y-2">
                        <h2 className="text-xl font-semibold">App Studio couldn&apos;t load</h2>
                        <p className="text-sm text-[var(--blanc-ink-2)]">{error}</p>
                    </div>
                </div>
            ) : loading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-[var(--blanc-ink-2)]">
                    <Loader2 className="size-4 animate-spin" /> Loading App Studio…
                </div>
            ) : (
                <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)_260px]">
                    <aside aria-label="Apps" className="min-h-0 overflow-y-auto">
                        <div className="blanc-eyebrow mb-3">Your apps</div>
                        {chats.length === 0 ? (
                            <div className="py-8 text-sm text-[var(--blanc-ink-2)]">
                                No apps yet. Start with New app.
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {chats.map(chat => (
                                    <button
                                        key={chat.id}
                                        type="button"
                                        onClick={() => onSelectChat(chat.id)}
                                        aria-current={selectedChatId === chat.id ? 'true' : undefined}
                                        className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
                                            selectedChatId === chat.id
                                                ? 'border-[var(--blanc-line-strong)] bg-[var(--blanc-surface-strong)]'
                                                : 'border-[var(--blanc-line)] hover:border-[var(--blanc-line-strong)]'
                                        }`}
                                    >
                                        <div className="text-sm font-semibold">{chat.app_name || chat.title}</div>
                                        <div className="mt-1 text-xs text-[var(--blanc-ink-3)]">
                                            {chat.message_count || 0} messages
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </aside>

                    <main aria-label="App chat" className="flex min-h-0 flex-col">
                        {!selectedChatId ? (
                            <div className="flex flex-1 items-center justify-center text-center text-sm text-[var(--blanc-ink-2)]">
                                Select an app or create a new one to start chatting.
                            </div>
                        ) : (
                            <>
                                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
                                    {messages.length === 0 ? (
                                        <div className="flex min-h-[240px] items-center justify-center text-center text-sm text-[var(--blanc-ink-2)]">
                                            Tell the builder what this app should do.
                                        </div>
                                    ) : messages.map(message => {
                                        const version = message.version_id
                                            ? versionsById.get(message.version_id)
                                            : undefined;
                                        const assistant = message.role === 'assistant';
                                        return (
                                            <div
                                                key={message.id}
                                                className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                                                    assistant
                                                        ? 'bg-[var(--blanc-surface-strong)]'
                                                        : 'ml-auto bg-[var(--blanc-accent-soft)]'
                                                }`}
                                            >
                                                {assistant && (
                                                    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--blanc-ink-3)]">
                                                        <Bot className="size-3.5" /> App Studio
                                                    </div>
                                                )}
                                                <p>{message.text}</p>
                                                {version && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            onClick={() => onProfileOpenChange(true)}
                                                            className="mt-3 rounded-lg bg-[var(--blanc-accent-soft)] px-2.5 py-1.5 text-xs font-semibold text-[var(--blanc-accent)]"
                                                        >
                                                            {appStudioVersionLabel(version)}
                                                        </button>
                                                        <SandboxResult version={version} />
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="flex items-end gap-2 pt-2">
                                    <FloatingField
                                        label="Describe the next version"
                                        textarea
                                        rows={2}
                                        value={composer}
                                        disabled={sending || quotaExhausted}
                                        onChange={event => onComposerChange(event.target.value)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' && !event.shiftKey) {
                                                event.preventDefault();
                                                onSend();
                                            }
                                        }}
                                        containerClassName="flex-1"
                                    />
                                    <Button
                                        size="icon"
                                        aria-label="Send message"
                                        onClick={onSend}
                                        disabled={!composer.trim() || sending || quotaExhausted}
                                    >
                                        {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                                    </Button>
                                </div>
                                {profile && (
                                    <Button
                                        variant="ghost"
                                        className="mt-2 lg:hidden"
                                        onClick={() => onProfileOpenChange(true)}
                                    >
                                        <MessageSquareText className="size-4" /> View app profile
                                    </Button>
                                )}
                            </>
                        )}
                    </main>

                    <aside
                        aria-label="App profile"
                        data-testid="app-profile-panel"
                        className="hidden min-h-0 overflow-y-auto lg:block"
                    >
                        <ProfileContent profile={profile} />
                    </aside>
                </div>
            )}

            <Dialog open={profileOpen} onOpenChange={onProfileOpenChange}>
                <DialogContent variant="panel">
                    <DialogPanelHeader>
                        <div className="blanc-eyebrow">App Studio</div>
                        <DialogTitle>App profile</DialogTitle>
                    </DialogPanelHeader>
                    <DialogBody className="md:px-8 md:py-7">
                        <div className="mx-auto w-full max-w-[740px] space-y-6">
                            <ProfileContent profile={profile} />
                        </div>
                    </DialogBody>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function AppStudioDataPage() {
    const queryClient = useQueryClient();
    const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
    const [composer, setComposer] = useState('');
    const [quotaExhausted, setQuotaExhausted] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);

    const chatsQuery = useQuery({
        queryKey: ['app-studio', 'chats'],
        queryFn: listAppStudioChats,
    });
    const selectedChat = chatsQuery.data?.find(chat => chat.id === selectedChatId) || null;
    const messagesQuery = useQuery({
        queryKey: ['app-studio', 'messages', selectedChatId],
        queryFn: () => getAppStudioMessages(selectedChatId as string),
        enabled: Boolean(selectedChatId),
    });
    const appId = messagesQuery.data?.chat.app_id || selectedChat?.app_id || null;
    const versionsQuery = useQuery({
        queryKey: ['app-studio', 'versions', appId],
        queryFn: () => listAppStudioVersions(appId as string),
        enabled: Boolean(appId),
    });

    useEffect(() => {
        if (!selectedChatId && chatsQuery.data?.[0]) setSelectedChatId(chatsQuery.data[0].id);
    }, [chatsQuery.data, selectedChatId]);

    const createMutation = useMutation({
        mutationFn: createAppStudioChat,
        onSuccess: chat => {
            setSelectedChatId(chat.id);
            setQuotaExhausted(false);
            queryClient.invalidateQueries({ queryKey: ['app-studio', 'chats'] });
        },
    });
    const sendMutation = useMutation({
        mutationFn: (text: string) => sendAppStudioMessage(selectedChatId as string, text),
        onSuccess: result => {
            setComposer('');
            queryClient.invalidateQueries({ queryKey: ['app-studio', 'chats'] });
            queryClient.invalidateQueries({ queryKey: ['app-studio', 'messages', selectedChatId] });
            if (result.app_id) {
                queryClient.invalidateQueries({ queryKey: ['app-studio', 'versions', result.app_id] });
            }
        },
        onError: error => {
            if (error instanceof AppStudioApiError && error.status === 429) setQuotaExhausted(true);
            queryClient.invalidateQueries({ queryKey: ['app-studio', 'messages', selectedChatId] });
        },
    });

    const messages = messagesQuery.data?.messages || [];
    const versions = versionsQuery.data?.versions || [];
    const latestVersion = versions[0];
    const description = latestVersion
        ? messages.find(message => message.version_id === latestVersion.id)?.text
        : undefined;
    const profile = appId ? {
        name: versionsQuery.data?.app.name || selectedChat?.app_name || selectedChat?.title || 'App',
        description,
        version: latestVersion,
    } : null;
    const queryError = chatsQuery.error || messagesQuery.error || versionsQuery.error;

    return (
        <AppStudioWorkspace
            chats={chatsQuery.data || []}
            selectedChatId={selectedChatId}
            messages={messages}
            versions={versions}
            profile={profile}
            loading={chatsQuery.isLoading || (Boolean(selectedChatId) && messagesQuery.isLoading)}
            error={queryError instanceof Error ? queryError.message : null}
            quotaExhausted={quotaExhausted}
            composer={composer}
            creating={createMutation.isPending}
            sending={sendMutation.isPending}
            profileOpen={profileOpen}
            onSelectChat={chatId => {
                setSelectedChatId(chatId);
                setQuotaExhausted(false);
                setProfileOpen(false);
            }}
            onNewApp={() => createMutation.mutate()}
            onComposerChange={setComposer}
            onSend={() => {
                const text = composer.trim();
                if (text && selectedChatId && !sendMutation.isPending && !quotaExhausted) {
                    sendMutation.mutate(text);
                }
            }}
            onProfileOpenChange={setProfileOpen}
        />
    );
}

export default function AppStudioPage() {
    const { membership } = useAuthz();
    if (!canAccessAppStudio(membership?.role_key)) return <AppStudioAccessDenied />;
    return <AppStudioDataPage />;
}

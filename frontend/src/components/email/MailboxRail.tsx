import { Inbox, Mail, Send, Eye, Paperclip, RefreshCw } from 'lucide-react';
import type { EmailMailbox } from '../../services/emailApi';

interface MailboxRailProps {
    mailbox: EmailMailbox | null;
    activeView: string;
    onViewChange: (view: string) => void;
    onSync?: () => void;
    isSyncing?: boolean;
}

const VIEWS = [
    { key: 'inbox', label: 'Inbox', icon: Inbox },
    { key: 'all', label: 'All', icon: Mail },
    { key: 'sent', label: 'Sent', icon: Send },
    { key: 'unread', label: 'Unread', icon: Eye },
    { key: 'attachments', label: 'With attachments', icon: Paperclip },
];

export function MailboxRail({ mailbox, activeView, onViewChange, onSync, isSyncing }: MailboxRailProps) {
    return (
        <div className="flex flex-col h-full" style={{ width: '200px', minWidth: '200px', borderRight: '1px solid var(--blanc-line)' }}>
            {/* Mailbox identity */}
            {mailbox && (
                <div className="px-3 py-3" style={{ borderBottom: '1px solid var(--blanc-line)' }}>
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>
                        {mailbox.email_address}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>
                        {mailbox.status === 'connected' ? 'Gmail' : mailbox.status.replace('_', ' ')}
                    </p>
                </div>
            )}

            {/* View filters */}
            <nav className="flex-1 py-2">
                {VIEWS.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm text-left"
                        onClick={() => onViewChange(key)}
                        style={{
                            background: activeView === key ? 'rgba(117, 106, 89, 0.08)' : 'transparent',
                            color: activeView === key ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-2)',
                            fontWeight: activeView === key ? 500 : 400,
                            border: 'none', cursor: 'pointer', borderRadius: '6px',
                            margin: '0 6px',
                        }}
                    >
                        <Icon className="size-3.5" />
                        {label}
                    </button>
                ))}
            </nav>

            {/* Sync button */}
            {mailbox && mailbox.status === 'connected' && onSync && (
                <div className="px-3 py-3" style={{ borderTop: '1px solid var(--blanc-line)' }}>
                    <button
                        className="flex items-center gap-1.5 text-xs w-full justify-center"
                        onClick={onSync}
                        disabled={isSyncing}
                        style={{
                            color: 'var(--blanc-ink-3)', background: 'transparent',
                            border: 'none', cursor: 'pointer',
                        }}
                    >
                        <RefreshCw className={`size-3 ${isSyncing ? 'animate-spin' : ''}`} />
                        {isSyncing ? 'Syncing...' : 'Sync'}
                    </button>
                </div>
            )}
        </div>
    );
}

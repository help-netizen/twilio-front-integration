import { Paperclip } from 'lucide-react';
import type { EmailThread } from '../../services/emailApi';
import { formatCompanyTime, useCompanyTime } from '../../lib/companyTime';

interface EmailThreadRowProps {
    thread: EmailThread;
    isSelected: boolean;
    onClick: () => void;
}

function formatTime(iso: string | null, timeZone: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const dayOptions = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
    const isToday = formatCompanyTime(d, dayOptions, timeZone, 'en-CA')
        === formatCompanyTime(now, dayOptions, timeZone, 'en-CA');
    if (isToday) return formatCompanyTime(d, { hour: 'numeric', minute: '2-digit' }, timeZone);
    return formatCompanyTime(d, { month: 'short', day: 'numeric' }, timeZone);
}

export function EmailThreadRow({ thread, isSelected, onClick }: EmailThreadRowProps) {
    const { timeZone } = useCompanyTime();
    const isUnread = thread.unread_count > 0;

    return (
        <div
            className="px-3 py-2.5 cursor-pointer"
            onClick={onClick}
            style={{
                background: isSelected ? 'rgba(25, 25, 25, 0.06)' : 'transparent',
                borderBottom: '1px solid var(--blanc-line)',
            }}
        >
            <div className="flex items-start justify-between gap-2">
                <p
                    className="text-sm truncate flex-1"
                    style={{
                        color: 'var(--blanc-ink-1)',
                        fontWeight: isUnread ? 600 : 400,
                    }}
                >
                    {thread.last_message_from || 'Unknown'}
                </p>
                <span className="text-xs shrink-0" style={{ color: 'var(--blanc-ink-3)' }}>
                    {formatTime(thread.last_message_at, timeZone)}
                </span>
            </div>

            <p
                className="text-sm truncate mt-0.5"
                style={{
                    color: 'var(--blanc-ink-1)',
                    fontWeight: isUnread ? 500 : 400,
                }}
            >
                {thread.subject || '(no subject)'}
            </p>

            <div className="flex items-center gap-2 mt-0.5">
                <p className="text-xs truncate flex-1" style={{ color: 'var(--blanc-ink-3)' }}>
                    {thread.last_message_preview || ''}
                </p>
                <div className="flex items-center gap-1.5 shrink-0">
                    {thread.has_attachments && <Paperclip className="size-3" style={{ color: 'var(--blanc-ink-3)' }} />}
                    {isUnread && (
                        <span
                            className="inline-block rounded-full text-white text-xs font-medium px-1.5"
                            style={{ background: 'var(--blanc-ink-1)', fontSize: '10px', lineHeight: '16px' }}
                        >
                            {thread.unread_count}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

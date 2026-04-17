import { useState } from 'react';
import { Search, Mail } from 'lucide-react';
import { EmailThreadRow } from './EmailThreadRow';
import type { EmailThread } from '../../services/emailApi';

interface EmailThreadListProps {
    threads: EmailThread[];
    selectedThreadId: number | null;
    onSelectThread: (threadId: number) => void;
    hasMore: boolean;
    onLoadMore: () => void;
    isLoading: boolean;
    searchQuery: string;
    onSearchChange: (q: string) => void;
}

export function EmailThreadList({
    threads, selectedThreadId, onSelectThread,
    hasMore, onLoadMore, isLoading,
    searchQuery, onSearchChange,
}: EmailThreadListProps) {
    const [inputValue, setInputValue] = useState(searchQuery);

    const handleSearchSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSearchChange(inputValue);
    };

    return (
        <div className="flex flex-col h-full" style={{ width: '340px', minWidth: '280px', borderRight: '1px solid var(--blanc-line)' }}>
            {/* Search */}
            <form onSubmit={handleSearchSubmit} className="px-3 py-2" style={{ borderBottom: '1px solid var(--blanc-line)' }}>
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                    <input
                        type="text"
                        placeholder="Search emails..."
                        value={inputValue}
                        onChange={e => setInputValue(e.target.value)}
                        className="w-full text-sm pl-8 pr-3 py-1.5"
                        style={{
                            background: 'rgba(117, 106, 89, 0.04)',
                            border: '1px solid var(--blanc-line)',
                            borderRadius: '8px',
                            color: 'var(--blanc-ink-1)',
                            outline: 'none',
                        }}
                    />
                </div>
            </form>

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto">
                {isLoading && threads.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                        <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>Loading...</p>
                    </div>
                ) : threads.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-2">
                        <Mail className="size-8" style={{ color: 'var(--blanc-ink-3)' }} />
                        <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                            {searchQuery ? 'No results found' : 'No emails yet'}
                        </p>
                    </div>
                ) : (
                    <>
                        {threads.map(thread => (
                            <EmailThreadRow
                                key={thread.id}
                                thread={thread}
                                isSelected={thread.id === selectedThreadId}
                                onClick={() => onSelectThread(thread.id)}
                            />
                        ))}
                        {hasMore && (
                            <button
                                className="w-full py-2 text-xs text-center"
                                onClick={onLoadMore}
                                disabled={isLoading}
                                style={{ color: 'var(--blanc-ink-2)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                            >
                                {isLoading ? 'Loading...' : 'Load more'}
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

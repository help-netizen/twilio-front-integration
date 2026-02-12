import React, { useState } from 'react';
import { useCallsByContact } from '../../hooks/useConversations';
import { useRealtimeEvents, type SSECallEvent } from '../../hooks/useRealtimeEvents';
import { useQueryClient } from '@tanstack/react-query';
import { ConversationListItem } from './ConversationListItem';
import { normalizePhoneNumber } from '../../utils/formatters';
import { Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';
import { Search, PhoneOff } from 'lucide-react';
import type { ByContactResponse } from '../../types/models';

export const ConversationList: React.FC = () => {
    const { data, isLoading, error, refetch } = useCallsByContact();
    const [searchQuery, setSearchQuery] = useState('');
    const queryClient = useQueryClient();

    /**
     * Update a call in the react-query cache inline from SSE data.
     * If the call is found, update it; if not, refetch the list.
     */
    const updateCacheFromSSE = (event: SSECallEvent) => {
        const updated = queryClient.setQueryData<ByContactResponse>(
            ['calls-by-contact'],
            (old) => {
                if (!old) return old;
                const idx = old.conversations.findIndex(
                    (c) => c.call_sid === event.call_sid || c.contact?.id === event.contact?.id
                );
                if (idx === -1) return old; // not in list — trigger refetch below

                const updatedConversations = [...old.conversations];
                updatedConversations[idx] = {
                    ...updatedConversations[idx],
                    status: event.status as any,
                    is_final: event.is_final ?? updatedConversations[idx].is_final,
                    duration_sec: event.duration_sec ?? updatedConversations[idx].duration_sec,
                    ended_at: event.ended_at ?? updatedConversations[idx].ended_at,
                    updated_at: event.updated_at ?? updatedConversations[idx].updated_at,
                };
                return { ...old, conversations: updatedConversations };
            }
        );
        // If the call wasn't found in cache, refetch to pick it up
        if (!updated || !updated.conversations.some(c => c.call_sid === event.call_sid || c.contact?.id === event.contact?.id)) {
            refetch();
        }
    };

    // Subscribe to real-time events
    const { connected } = useRealtimeEvents({
        onCallUpdate: (event) => {
            console.log('[CallList] Call updated:', event.call_sid, event.status);
            // Skip child legs — they don't appear in the by-contact list
            if (event.parent_call_sid) return;
            updateCacheFromSSE(event);
            // Also invalidate contact-calls cache if viewing details
            if (event.contact_id) {
                queryClient.invalidateQueries({ queryKey: ['contact-calls', event.contact_id] });
            }
        },
        onCallCreated: (event) => {
            console.log('[CallList] Call created:', event.call_sid);
            if (event.parent_call_sid) return;
            refetch(); // New call — refetch to add to list
        }
    });

    // Filter by phone number search
    const calls = data?.conversations || [];
    const filteredCalls = React.useMemo(() => {
        if (!searchQuery.trim()) return calls;

        const normalizedQuery = normalizePhoneNumber(searchQuery);
        return calls.filter(call => {
            const phone = call.from_number || call.to_number || '';
            return normalizePhoneNumber(phone).includes(normalizedQuery);
        });
    }, [calls, searchQuery]);

    if (isLoading) {
        return (
            <div className="h-full flex flex-col">
                <div className="flex items-center justify-between p-3 border-b gap-3">
                    <h2 className="text-lg font-semibold shrink-0">Inbox</h2>
                </div>
                <div className="p-3 space-y-2">
                    {[...Array(8)].map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                    ))}
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="h-full flex flex-col">
                <div className="flex items-center justify-between p-3 border-b gap-3">
                    <h2 className="text-lg font-semibold shrink-0">Inbox</h2>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <p className="text-sm text-destructive">Error loading calls</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col">
            <div className="flex items-center p-3 border-b gap-3">
                <h2 className="text-lg font-semibold shrink-0">Inbox</h2>
                <div
                    className="size-2.5 rounded-full shrink-0 transition-colors"
                    style={{ backgroundColor: connected ? '#10b981' : undefined }}
                    title={connected ? 'Real-time updates active' : 'Connecting...'}
                >
                    {!connected && <div className="size-2.5 rounded-full bg-muted-foreground" />}
                </div>
                <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <Input
                        placeholder="Search phone..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-8 h-8 text-sm"
                    />
                </div>
            </div>
            <div className="flex-1 overflow-y-auto">
                {filteredCalls.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center py-12">
                        <PhoneOff className="size-8 mx-auto mb-2 opacity-20" />
                        <p className="text-sm text-muted-foreground">No calls found</p>
                    </div>
                ) : (
                    filteredCalls.map((call) => (
                        <ConversationListItem key={call.id} call={call} />
                    ))
                )}
            </div>
        </div>
    );
};

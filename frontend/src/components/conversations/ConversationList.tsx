import React, { useState } from 'react';
import { useCallsByContact } from '../../hooks/useConversations';
import { useRealtimeEvents } from '../../hooks/useRealtimeEvents';
import { useQueryClient } from '@tanstack/react-query';
import { ConversationListItem } from './ConversationListItem';
import { normalizePhoneNumber } from '../../utils/formatters';
import { Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';
import { Search, PhoneOff } from 'lucide-react';

export const ConversationList: React.FC = () => {
    const { data, isLoading, error, refetch } = useCallsByContact();
    const [searchQuery, setSearchQuery] = useState('');
    const queryClient = useQueryClient();

    const refreshScopedCalls = () => {
        void refetch();
        void queryClient.invalidateQueries({ queryKey: ['contact-calls'] });
        void queryClient.invalidateQueries({ queryKey: ['call'] });
    };

    const { connected } = useRealtimeEvents({
        onCallUpdate: refreshScopedCalls,
        onCallCreated: refreshScopedCalls,
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

    // Use server-provided leads_map (enrichment done server-side)
    const leadsMap = data?.leads_map || {};
    const getLeadForPhone = (rawPhone: string | undefined) => {
        if (!rawPhone) return null;
        const d = (rawPhone || '').replace(/\D/g, '');
        const key = d.length >= 10 ? d.slice(-10) : d;
        return leadsMap[key] ?? null;
    };

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
                        <ConversationListItem
                            key={call.id}
                            call={call}
                            prefetchedLead={getLeadForPhone(
                                (call as any).tl_phone || call.contact?.phone_e164 || call.from_number || call.to_number
                            )}
                        />
                    ))
                )}
            </div>
        </div>
    );
};

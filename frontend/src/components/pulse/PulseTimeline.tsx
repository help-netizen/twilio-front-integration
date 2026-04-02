import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import type { CallData } from '../call-list-item';
import { PulseCallListItem } from './PulseCallListItem';
import type { SmsMessage, TimelineItem, FinancialEvent } from '../../types/pulse';
import { DateSeparator } from './DateSeparator';
import { SmsListItem } from './SmsListItem';
import { FinancialEventListItem } from './FinancialEventListItem';
import { useAuth } from '../../auth/AuthProvider';

interface PulseTimelineProps {
    calls: CallData[];
    messages: SmsMessage[];
    loading: boolean;
    timelineKey?: string | number;
    financialEvents?: FinancialEvent[];
}

function toTZDateKey(date: Date, tz: string): string {
    return date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

function formatDateSep(date: Date, tz: string): string {
    const nowKey = toTZDateKey(new Date(), tz);
    const dateKey = toTZDateKey(date, tz);
    if (dateKey === nowKey) return 'Today';
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateKey === toTZDateKey(yesterday, tz)) return 'Yesterday';
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
}

export function PulseTimeline({ calls, messages, loading, timelineKey, financialEvents = [] }: PulseTimelineProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const endRef = useRef<HTMLDivElement>(null);
    const [showJumpBtn, setShowJumpBtn] = useState(false);

    // Build a sorted timeline from calls + messages
    const timeline = useMemo(() => {
        const items: TimelineItem[] = [];

        // Add calls
        for (const call of calls) {
            items.push({
                type: 'call',
                timestamp: call.startTime,
                data: call,
            });
        }

        // Add SMS messages
        for (const msg of messages) {
            items.push({
                type: 'sms',
                timestamp: new Date(msg.date_created_remote || msg.created_at),
                data: msg,
            });
        }

        // Add financial events
        for (const evt of financialEvents) {
            items.push({
                type: 'financial',
                timestamp: new Date(evt.occurred_at),
                data: evt,
            });
        }

        // Sort chronologically (oldest first)
        items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        return items;
    }, [calls, messages, financialEvents]);

    // Show "jump to latest" button when timeline has items
    useEffect(() => {
        setShowJumpBtn(!loading && timeline.length > 3);
    }, [timeline.length, loading, timelineKey]);

    const handleJumpToLatest = useCallback(() => {
        // Scroll the right column to the very bottom so the SMS form is also visible
        const scrollContainer = endRef.current?.closest('.pulse-right-column') || document.querySelector('.pulse-right-column');
        if (scrollContainer) {
            scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
        } else {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        }
        setShowJumpBtn(false);
    }, []);

    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--blanc-ink-3)' }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ width: '32px', height: '32px', border: '3px solid var(--blanc-line)', borderTopColor: 'var(--blanc-info)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                    Loading timeline...
                </div>
            </div>
        );
    }

    if (timeline.length === 0) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--blanc-ink-3)' }}>
                No activity found for this contact
            </div>
        );
    }

    // Render timeline items with date separators
    let lastDateStr = '';
    const rendered: React.ReactNode[] = [];

    for (let i = 0; i < timeline.length; i++) {
        const item = timeline[i];
        const dateStr = toTZDateKey(item.timestamp, companyTz);

        // Insert date separator on date change
        if (dateStr !== lastDateStr) {
            rendered.push(
                <DateSeparator key={`date-${dateStr}`} date={formatDateSep(item.timestamp, companyTz)} />
            );
            lastDateStr = dateStr;
        }

        if (item.type === 'call') {
            rendered.push(
                <div key={`call-${(item.data as CallData).id}`} style={{ padding: '5px 20px' }}>
                    <PulseCallListItem call={item.data as CallData} />
                </div>
            );
        } else if (item.type === 'financial') {
            rendered.push(
                <div key={`fin-${(item.data as FinancialEvent).id}`} style={{ padding: '5px 20px' }}>
                    <FinancialEventListItem event={item.data as FinancialEvent} />
                </div>
            );
        } else {
            rendered.push(
                <div key={`sms-${(item.data as SmsMessage).id}`} style={{ padding: '5px 20px' }}>
                    <SmsListItem sms={item.data as SmsMessage} />
                </div>
            );
        }
    }

    return (
        <div style={{ padding: '12px 0' }}>
            {rendered}
            <div ref={endRef} />
            {/* Floating "Jump to latest" button — fixed at bottom-right of viewport */}
            {showJumpBtn && (
                <button
                    onClick={handleJumpToLatest}
                    className="fixed inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-sm font-medium shadow-lg transition-all hover:shadow-xl hover:scale-105"
                    style={{
                        bottom: '90px',
                        right: '40px',
                        background: 'var(--blanc-ink-1)',
                        color: '#fff',
                        zIndex: 20,
                    }}
                >
                    <ChevronDown className="size-4" />
                    Jump to latest
                </button>
            )}
        </div>
    );
}

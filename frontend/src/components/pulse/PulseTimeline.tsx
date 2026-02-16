import { useRef, useEffect, useMemo } from 'react';
import type { CallData } from '../call-list-item';
import { PulseCallListItem } from './PulseCallListItem';
import type { SmsMessage, TimelineItem } from '../../types/pulse';
import { DateSeparator } from './DateSeparator';
import { SmsListItem } from './SmsListItem';

interface PulseTimelineProps {
    calls: CallData[];
    messages: SmsMessage[];
    loading: boolean;
}

function formatDateSeparator(date: Date): string {
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function PulseTimeline({ calls, messages, loading }: PulseTimelineProps) {
    const endRef = useRef<HTMLDivElement>(null);

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

        // Sort chronologically (oldest first)
        items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        return items;
    }, [calls, messages]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (!loading && timeline.length > 0) {
            endRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [timeline.length, loading]);

    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: '#9ca3af' }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ width: '32px', height: '32px', border: '3px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                    Loading timeline...
                </div>
            </div>
        );
    }

    if (timeline.length === 0) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: '#9ca3af' }}>
                No activity found for this contact
            </div>
        );
    }

    // Render timeline items with date separators
    let lastDateStr = '';
    const rendered: React.ReactNode[] = [];

    for (let i = 0; i < timeline.length; i++) {
        const item = timeline[i];
        const dateStr = item.timestamp.toDateString();

        // Insert date separator on date change
        if (dateStr !== lastDateStr) {
            rendered.push(
                <DateSeparator key={`date-${dateStr}`} date={formatDateSeparator(item.timestamp)} />
            );
            lastDateStr = dateStr;
        }

        if (item.type === 'call') {
            rendered.push(
                <div key={`call-${(item.data as CallData).id}`} style={{ padding: '4px 16px' }}>
                    <PulseCallListItem call={item.data as CallData} />
                </div>
            );
        } else {
            rendered.push(
                <SmsListItem key={`sms-${(item.data as SmsMessage).id}`} message={item.data as SmsMessage} />
            );
        }
    }

    return (
        <div style={{ padding: '8px 0' }}>
            {rendered}
            <div ref={endRef} />
        </div>
    );
}

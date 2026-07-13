import { useRef, useState, useEffect, useMemo, useCallback, useLayoutEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { PulseCallListItem } from './PulseCallListItem';
import type { SmsMessage, TimelinePageItem, FinancialEvent, EmailTimelineItem } from '../../types/pulse';
import { DateSeparator } from './DateSeparator';
import { SmsListItem } from './SmsListItem';
import { EmailListItem } from './EmailListItem';
import { FinancialEventListItem } from './FinancialEventListItem';
import { callToCallData } from './pulseHelpers';
import { useAuth } from '../../auth/AuthProvider';

interface PulseTimelineProps {
    items: TimelinePageItem[];
    loading: boolean;
    timelineKey?: string | number;
    hasOlder: boolean;
    isFetchingOlder: boolean;
    onLoadOlder: () => void;
    scrollToBottomSignal?: number;
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

export function PulseTimeline({
    items,
    loading,
    timelineKey,
    hasOlder,
    isFetchingOlder,
    onLoadOlder,
    scrollToBottomSignal = 0,
}: PulseTimelineProps) {
    const { company } = useAuth();
    const companyTz = company?.timezone || 'America/New_York';
    const sentinelRef = useRef<HTMLDivElement>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const anchoredRef = useRef(false);
    const nearBottomRef = useRef(true);
    const prevScrollHeightRef = useRef<number | null>(null);
    const newestItemRef = useRef<{ timelineKey?: string | number; itemKey: string | null }>({
        timelineKey,
        itemKey: null,
    });
    const anchorRafRef = useRef<number | null>(null);
    const compensationRafRef = useRef<number | null>(null);
    const resizeRafRef = useRef<number | null>(null);
    const [ioEnabled, setIoEnabled] = useState(false);
    const [nearBottom, setNearBottom] = useState(true);
    const [hasNewActivity, setHasNewActivity] = useState(false);

    const hasItems = items.length > 0;
    const newestItem = items[items.length - 1];
    const newestItemKey = newestItem ? `${newestItem.src}:${newestItem.id}` : null;

    const callDataById = useMemo(() => {
        const mapped = new Map<string, ReturnType<typeof callToCallData>>();
        for (const item of items) {
            if (item.src === 'call') mapped.set(item.id, callToCallData(item.data));
        }
        return mapped;
    }, [items]);

    const getScrollContainer = useCallback(() => {
        const end = endRef.current;
        if (!end) return null;

        let ancestor = end.parentElement;
        while (ancestor) {
            const overflowY = getComputedStyle(ancestor).overflowY;
            const canScroll = overflowY === 'auto' || overflowY === 'scroll';
            if (canScroll && ancestor.scrollHeight > ancestor.clientHeight + 1) return ancestor;
            ancestor = ancestor.parentElement;
        }

        return (end.closest('.pulse-right-column') as HTMLElement | null)
            ?? (document.scrollingElement as HTMLElement | null);
    }, []);

    const updateNearBottom = useCallback((container = getScrollContainer()) => {
        if (!container) return false;
        const nextNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= 120;
        nearBottomRef.current = nextNearBottom;
        setNearBottom(current => current === nextNearBottom ? current : nextNearBottom);
        if (nextNearBottom) setHasNewActivity(false);
        return nextNearBottom;
    }, [getScrollContainer]);

    const scrollToBottom = useCallback(() => {
        const container = getScrollContainer();
        if (container) container.scrollTop = container.scrollHeight;
    }, [getScrollContainer]);

    // Reset thread-local scroll state before the new thread can paint.
    useLayoutEffect(() => {
        anchoredRef.current = false;
        nearBottomRef.current = true;
        prevScrollHeightRef.current = null;
        newestItemRef.current = { timelineKey, itemKey: null };
        setIoEnabled(false);
        setNearBottom(true);
        setHasNewActivity(false);

        if (anchorRafRef.current !== null) cancelAnimationFrame(anchorRafRef.current);
        if (compensationRafRef.current !== null) cancelAnimationFrame(compensationRafRef.current);
        if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
        anchorRafRef.current = null;
        compensationRafRef.current = null;
        resizeRafRef.current = null;
    }, [timelineKey]);

    // Mobile Pulse scrolls .app-main; disable native anchoring there while this feed is mounted.
    useLayoutEffect(() => {
        if (!hasItems) return;
        const container = getScrollContainer();
        if (!container || container.classList.contains('pulse-right-column')) return;

        const previousOverflowAnchor = container.style.overflowAnchor;
        container.style.overflowAnchor = 'none';
        return () => { container.style.overflowAnchor = previousOverflowAnchor; };
    }, [timelineKey, hasItems, getScrollContainer]);

    // Initial bottom anchor happens after DOM commit but before paint.
    useLayoutEffect(() => {
        if (loading || anchoredRef.current) return;
        const container = getScrollContainer();
        if (!container) return;

        container.scrollTop = container.scrollHeight;
        anchoredRef.current = true;
        nearBottomRef.current = true;
        setNearBottom(true);
        setIoEnabled(true);

        if (anchorRafRef.current !== null) cancelAnimationFrame(anchorRafRef.current);
        anchorRafRef.current = requestAnimationFrame(() => {
            anchorRafRef.current = null;
            const currentContainer = getScrollContainer();
            if (anchoredRef.current && currentContainer) {
                currentContainer.scrollTop = currentContainer.scrollHeight;
            }
        });
    }, [timelineKey, loading, items.length, getScrollContainer]);

    // Preserve the visible rows after older items are prepended.
    useLayoutEffect(() => {
        if (isFetchingOlder || prevScrollHeightRef.current === null) return;
        const container = getScrollContainer();
        if (!container) {
            prevScrollHeightRef.current = null;
            return;
        }

        const delta = container.scrollHeight - prevScrollHeightRef.current;
        const targetScrollTop = container.scrollTop + delta;
        container.scrollTop = targetScrollTop;
        prevScrollHeightRef.current = null;

        if (compensationRafRef.current !== null) cancelAnimationFrame(compensationRafRef.current);
        compensationRafRef.current = requestAnimationFrame(() => {
            compensationRafRef.current = null;
            const currentContainer = getScrollContainer();
            if (currentContainer) currentContainer.scrollTop = targetScrollTop;
        });
    }, [items, isFetchingOlder, getScrollContainer]);

    // Track the 120px bottom belt for auto-stick and pill visibility.
    useEffect(() => {
        if (!hasItems) return;
        const container = getScrollContainer();
        if (!container) return;

        const handleScroll = () => updateNearBottom(container);

        handleScroll();
        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, [timelineKey, hasItems, hasOlder, getScrollContainer, updateNearBottom]);

    // Observe every column section so async cards above the feed cannot break the bottom pin.
    useEffect(() => {
        const container = getScrollContainer();
        if (!hasItems || !container) return;

        const handleObservedLayoutChange = () => {
            if (!nearBottomRef.current) {
                updateNearBottom(container);
                return;
            }
            if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
            resizeRafRef.current = requestAnimationFrame(() => {
                resizeRafRef.current = null;
                if (!nearBottomRef.current) {
                    updateNearBottom(container);
                    return;
                }
                container.scrollTop = container.scrollHeight;
                updateNearBottom(container);
            });
        };

        const resizeObserver = new ResizeObserver(handleObservedLayoutChange);
        const observedChildren = new Set<Element>();
        const syncObservedChildren = () => {
            const currentChildren = new Set(Array.from(container.children));
            for (const child of observedChildren) {
                if (currentChildren.has(child)) continue;
                resizeObserver.unobserve(child);
                observedChildren.delete(child);
            }
            for (const child of currentChildren) {
                if (observedChildren.has(child)) continue;
                resizeObserver.observe(child);
                observedChildren.add(child);
            }
        };

        const mutationObserver = new MutationObserver(() => {
            syncObservedChildren();
            handleObservedLayoutChange();
        });

        syncObservedChildren();
        // The container itself can SHRINK without any child resizing (e.g. a
        // banner mounting below steals layout height) — observe it too, or the
        // bottom pin silently drifts by exactly that delta.
        resizeObserver.observe(container);
        mutationObserver.observe(container, { childList: true });
        return () => {
            mutationObserver.disconnect();
            resizeObserver.disconnect();
            observedChildren.clear();
            if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
            resizeRafRef.current = null;
        };
    }, [timelineKey, hasItems, getScrollContainer, updateNearBottom]);

    // A changed tail key means new activity; prepends leave this key unchanged.
    useEffect(() => {
        const previous = newestItemRef.current;
        if (previous.timelineKey !== timelineKey) {
            newestItemRef.current = { timelineKey, itemKey: newestItemKey };
            return;
        }
        if (!newestItemKey) {
            previous.itemKey = null;
            return;
        }
        if (previous.itemKey === null) {
            previous.itemKey = newestItemKey;
            return;
        }
        if (previous.itemKey === newestItemKey) return;

        previous.itemKey = newestItemKey;
        if (nearBottomRef.current) scrollToBottom();
        else setHasNewActivity(true);
    }, [timelineKey, newestItemKey, scrollToBottom]);

    // Enable history pagination only after the initial bottom anchor.
    useEffect(() => {
        const sentinel = sentinelRef.current;
        const container = getScrollContainer();
        if (!ioEnabled || !hasOlder || isFetchingOlder || !sentinel || !container) return;

        const observer = new IntersectionObserver((entries) => {
            if (!entries[0]?.isIntersecting || !hasOlder || isFetchingOlder || !ioEnabled) return;
            prevScrollHeightRef.current = container.scrollHeight;
            onLoadOlder();
        }, { root: container, threshold: 0.1 });

        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [timelineKey, ioEnabled, hasOlder, isFetchingOlder, onLoadOlder, getScrollContainer]);

    // Successful sends bump this signal after refreshing the newest page.
    useEffect(() => {
        if (!scrollToBottomSignal) return;
        const container = getScrollContainer();
        if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }, [scrollToBottomSignal, getScrollContainer]);

    useEffect(() => () => {
        if (anchorRafRef.current !== null) cancelAnimationFrame(anchorRafRef.current);
        if (compensationRafRef.current !== null) cancelAnimationFrame(compensationRafRef.current);
        if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
    }, []);

    const handleJumpToLatest = useCallback(() => {
        const container = getScrollContainer();
        if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        setHasNewActivity(false);
    }, [getScrollContainer]);

    if (loading && !hasItems) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--blanc-ink-3)' }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ width: '32px', height: '32px', border: '3px solid var(--blanc-line)', borderTopColor: 'var(--blanc-info)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                    Loading timeline...
                </div>
            </div>
        );
    }

    if (!loading && !hasItems) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--blanc-ink-3)' }}>
                No activity found for this contact
            </div>
        );
    }

    // Render timeline items with date separators
    let lastDateStr = '';
    const rendered: React.ReactNode[] = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const timestamp = new Date(item.ts);
        const dateStr = toTZDateKey(timestamp, companyTz);

        // Insert date separator on date change
        if (dateStr !== lastDateStr) {
            rendered.push(
                <DateSeparator key={`date-${dateStr}`} date={formatDateSep(timestamp, companyTz)} />
            );
            lastDateStr = dateStr;
        }

        if (item.src === 'call') {
            rendered.push(
                <div key={`call-${item.id}`} style={{ padding: '5px 20px' }}>
                    <PulseCallListItem call={callDataById.get(item.id)!} />
                </div>
            );
        } else if (item.src === 'financial') {
            rendered.push(
                <div key={`fin-${item.id}`} style={{ padding: '5px 20px' }}>
                    <FinancialEventListItem event={item.data as FinancialEvent} />
                </div>
            );
        } else if (item.src === 'email') {
            rendered.push(
                <div key={`email-${item.id}`} style={{ padding: '5px 20px' }}>
                    <EmailListItem email={item.data as EmailTimelineItem} />
                </div>
            );
        } else {
            rendered.push(
                <div key={`sms-${item.id}`} style={{ padding: '5px 20px' }}>
                    <SmsListItem sms={item.data as SmsMessage} />
                </div>
            );
        }
    }

    return (
        <div style={{ padding: '12px 0' }}>
            {hasOlder && (
                <div ref={sentinelRef} className="pulse-feed-spinner-row">
                    {isFetchingOlder && (
                        <div style={{ width: '18px', height: '18px', border: '2px solid var(--blanc-line)', borderTopColor: 'var(--blanc-info)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    )}
                </div>
            )}
            {rendered}
            <div ref={endRef} />
            {(!nearBottom && items.length > 0) && (
                <button
                    type="button"
                    onClick={handleJumpToLatest}
                    aria-label={hasNewActivity ? 'Jump to latest — new activity' : 'Jump to latest'}
                    className="pulse-jump-to-latest fixed inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-sm font-medium shadow-lg transition-all hover:shadow-xl hover:scale-105"
                    style={{
                        bottom: '90px',
                        right: '40px',
                        background: 'var(--blanc-ink-1)',
                        color: 'var(--blanc-panel-surface)',
                        zIndex: 20,
                    }}
                >
                    {hasNewActivity && (
                        <span
                            aria-hidden="true"
                            className="pulse-jump-to-latest-dot"
                            style={{
                                position: 'absolute',
                                top: '-2px',
                                right: '-2px',
                                width: '8px',
                                height: '8px',
                                borderRadius: '999px',
                                background: 'var(--blanc-danger)',
                            }}
                        />
                    )}
                    <ChevronDown className="size-4" />
                    Jump to latest
                </button>
            )}
        </div>
    );
}

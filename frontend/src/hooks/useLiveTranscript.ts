/**
 * Live Transcript Store — module-level reactive store for streaming transcription
 *
 * Components subscribe via useLiveTranscript(callSid) and re-render
 * when new transcript lines arrive for their call.
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export interface LiveTranscriptLine {
    text: string;
    speaker: 'customer' | 'agent';
    turnOrder: number;
    isFinal: boolean;
    receivedAt: string;
}

// Module-level store: callSid → lines[]
const store = new Map<string, LiveTranscriptLine[]>();
// Subscribers: callSid → Set<() => void>
const subscribers = new Map<string, Set<() => void>>();

function notify(callSid: string) {
    const subs = subscribers.get(callSid);
    if (subs) subs.forEach(cb => cb());
}

/**
 * Append a transcript delta (called from SSE handler)
 */
export function appendTranscriptDelta(callSid: string, line: LiveTranscriptLine) {
    const lines = store.get(callSid) || [];

    // If this turnOrder already exists, update it (partial → final)
    const existingIdx = lines.findIndex(l => l.turnOrder === line.turnOrder);
    if (existingIdx >= 0) {
        lines[existingIdx] = line;
    } else {
        lines.push(line);
    }
    store.set(callSid, lines);
    notify(callSid);
}

/**
 * Replace with finalized full text (called from SSE handler)
 */
export function finalizeTranscript(callSid: string, fullText: string) {
    const lines: LiveTranscriptLine[] = fullText.split('\n').filter(l => l.trim()).map((line, idx) => {
        const match = line.match(/^(Customer|Agent):\s*(.*)/);
        return {
            text: match ? match[2] : line,
            speaker: match && match[1] === 'Agent' ? 'agent' as const : 'customer' as const,
            turnOrder: idx,
            isFinal: true,
            receivedAt: new Date().toISOString(),
        };
    });
    store.set(callSid, lines);
    notify(callSid);
}

/**
 * React hook — subscribe to live transcript for a specific callSid
 */
export function useLiveTranscript(callSid: string): LiveTranscriptLine[] {
    const [, forceUpdate] = useState(0);
    const callSidRef = useRef(callSid);
    callSidRef.current = callSid;

    const rerender = useCallback(() => forceUpdate(n => n + 1), []);

    useEffect(() => {
        if (!callSid) return;
        let subs = subscribers.get(callSid);
        if (!subs) {
            subs = new Set();
            subscribers.set(callSid, subs);
        }
        subs.add(rerender);

        return () => {
            subs!.delete(rerender);
            if (subs!.size === 0) subscribers.delete(callSid);
        };
    }, [callSid, rerender]);

    return store.get(callSid) || [];
}

/**
 * SSEPushBridge
 *
 * Listens for SSE events (message.added, call.created) and shows
 * browser Notification API alerts. This complements the backend
 * Web Push mechanism — it fires when the app tab IS open, while
 * Web Push fires when the tab is closed or in the background.
 */

import { useEffect, useRef } from 'react';
import { useRealtimeEvents, type SSEMessageAddedEvent, type SSECallEvent } from '../hooks/useRealtimeEvents';
import { authedFetch } from '../services/apiClient';
import { getPermissionState } from '../services/pushNotificationService';

// Track which conversation the user is currently viewing so we don't
// fire a notification for a message they can already see.
let activeConversationId: string | null = null;
export function setActiveConversation(id: string | null) { activeConversationId = id; }

// Debounce: skip duplicates within 2s window
const recentTags = new Map<string, number>();
function isDuplicate(tag: string): boolean {
    const now = Date.now();
    const prev = recentTags.get(tag);
    if (prev && now - prev < 2000) return true;
    recentTags.set(tag, now);
    // Cleanup old entries
    if (recentTags.size > 50) {
        for (const [k, v] of recentTags) { if (now - v > 5000) recentTags.delete(k); }
    }
    return false;
}

async function fetchNotificationSettings(): Promise<{ text: boolean; lead: boolean }> {
    try {
        const res = await authedFetch('/api/settings/notifications');
        const data = await res.json();
        return {
            text: !!data.config?.browser_push_new_text_message_enabled,
            lead: !!data.config?.browser_push_new_lead_enabled,
        };
    } catch {
        return { text: false, lead: false };
    }
}

function showNotification(title: string, body: string, url: string, tag: string) {
    if (getPermissionState() !== 'granted') return;
    if (isDuplicate(tag)) return;

    // Use service worker registration to show notification (works even when focused)
    navigator.serviceWorker?.getRegistration('/')?.then(reg => {
        if (reg) {
            reg.showNotification(title, {
                body,
                icon: '/vite.svg',
                tag,
                data: { url },
            });
        } else {
            // Fallback: direct Notification API
            const n = new Notification(title, { body, icon: '/vite.svg', tag });
            n.onclick = () => { window.focus(); window.location.href = url; n.close(); };
        }
    });
}

export default function SSEPushBridge() {
    const settingsRef = useRef<{ text: boolean; lead: boolean }>({ text: false, lead: false });

    // Load notification settings once on mount
    useEffect(() => {
        fetchNotificationSettings().then(s => { settingsRef.current = s; });
    }, []);

    useRealtimeEvents({
        // ── New inbound SMS ────────────────────────────────────────────
        onMessageAdded: (event: SSEMessageAddedEvent) => {
            if (!settingsRef.current.text) return;
            const msg = event.message;
            // Only notify for inbound messages
            if (msg?.direction !== 'inbound') return;
            // Skip if user is already viewing this conversation
            if (activeConversationId && event.conversationId === activeConversationId) return;

            const from = msg.author || msg.customer_e164 || 'Customer';
            const bodyPreview = (msg.body || '').substring(0, 80) || 'New message';
            const tag = `sse-sms-${event.conversationId}-${Date.now()}`;

            showNotification('New text message', `${from}: ${bodyPreview}`, '/pulse', tag);
        },

        // ── Inbound call ───────────────────────────────────────────────
        onCallCreated: (event: SSECallEvent) => {
            if (!event.direction || event.direction !== 'inbound') return;
            const from = event.from_number || 'Unknown';
            const tag = `sse-call-${event.call_sid}`;

            showNotification('Incoming call', `Call from ${from}`, '/pulse', tag);
        },
    });

    return null; // Renderless component
}

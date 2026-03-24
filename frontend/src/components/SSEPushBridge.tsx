/**
 * SSEPushBridge
 *
 * Listens for SSE events (message.added, call.created) and shows:
 * 1. Native OS browser notifications (via service worker showNotification)
 * 2. In-app toast notifications (via sonner)
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
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

function showOSNotification(title: string, body: string, url: string, tag: string) {
    if (getPermissionState() !== 'granted') return;
    navigator.serviceWorker?.getRegistration('/')?.then(reg => {
        if (reg) {
            reg.showNotification(title, { body, icon: '/vite.svg', tag, data: { url } });
        } else {
            const n = new Notification(title, { body, icon: '/vite.svg', tag });
            n.onclick = () => { window.focus(); window.location.href = url; n.close(); };
        }
    });
}

export default function SSEPushBridge() {
    const navigate = useNavigate();
    const settingsRef = useRef<{ text: boolean; lead: boolean }>({ text: false, lead: false });

    useEffect(() => {
        fetchNotificationSettings().then(s => { settingsRef.current = s; });
    }, []);

    useRealtimeEvents({
        onMessageAdded: (event: SSEMessageAddedEvent) => {
            if (!settingsRef.current.text) return;
            const msg = event.message;
            if (msg?.direction !== 'inbound') return;
            if (activeConversationId && event.conversationId === activeConversationId) return;

            const from = msg.author || msg.customer_e164 || 'Customer';
            const bodyPreview = (msg.body || '').substring(0, 80) || 'New message';
            const tag = `sse-sms-${event.conversationId}-${Date.now()}`;

            if (isDuplicate(tag)) return;

            // OS notification
            showOSNotification('New text message', `${from}: ${bodyPreview}`, '/pulse', tag);

            // In-app toast
            toast('💬 New text message', {
                description: `${from}: ${bodyPreview}`,
                duration: 6000,
                action: {
                    label: 'View',
                    onClick: () => navigate('/pulse'),
                },
            });
        },

        onCallCreated: (event: SSECallEvent) => {
            if (!event.direction || event.direction !== 'inbound') return;
            const from = event.from_number || 'Unknown';
            const tag = `sse-call-${event.call_sid}`;

            if (isDuplicate(tag)) return;

            showOSNotification('Incoming call', `Call from ${from}`, '/pulse', tag);

            toast('📞 Incoming call', {
                description: `Call from ${from}`,
                duration: 8000,
                action: {
                    label: 'View',
                    onClick: () => navigate('/pulse'),
                },
            });
        },
    });

    return null;
}

/**
 * Push Notification Service
 *
 * Manages browser push notification lifecycle:
 * - capability detection
 * - service worker registration
 * - push subscription creation/removal
 * - backend sync
 */

import { authedFetch } from './apiClient';

// ─── Browser Capability ──────────────────────────────────────────────────────

export type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export function isSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getPermissionState(): PermissionState {
    if (!isSupported()) return 'unsupported';
    return Notification.permission as PermissionState;
}

// ─── Service Worker Registration ─────────────────────────────────────────────

let swRegistration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!isSupported()) return null;
    try {
        swRegistration = await navigator.serviceWorker.register('/sw-push.js', { scope: '/' });
        console.log('[PushService] Service worker registered');
        return swRegistration;
    } catch (err) {
        console.error('[PushService] SW registration failed:', err);
        return null;
    }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (swRegistration) return swRegistration;
    if (!isSupported()) return null;
    swRegistration = (await navigator.serviceWorker.getRegistration('/')) || null;
    return swRegistration || null;
}

// ─── VAPID Key ───────────────────────────────────────────────────────────────

let vapidPublicKey: string | null = null;

async function getVapidPublicKey(): Promise<string> {
    if (vapidPublicKey) return vapidPublicKey;
    const res = await authedFetch('/api/push-subscriptions/vapid-public-key');
    const data = await res.json();
    if (!data.ok || !data.publicKey) throw new Error('VAPID key not available');
    vapidPublicKey = data.publicKey;
    return vapidPublicKey!;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// ─── Subscribe / Unsubscribe ─────────────────────────────────────────────────

export async function subscribeToPush(): Promise<boolean> {
    try {
        // 1. Request permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.warn('[PushService] Permission not granted:', permission);
            return false;
        }

        // 2. Register SW
        const reg = await registerServiceWorker();
        if (!reg) return false;

        // 3. Get VAPID key
        const publicKey = await getVapidPublicKey();

        // 4. Create push subscription
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });

        // 5. Send to backend
        const subJson = subscription.toJSON();
        const res = await authedFetch('/api/push-subscriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                endpoint: subJson.endpoint,
                keys: subJson.keys,
                browserName: getBrowserName(),
                userAgent: navigator.userAgent,
            }),
        });

        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Failed to register subscription');

        console.log('[PushService] Subscribed to push');
        return true;
    } catch (err) {
        console.error('[PushService] Subscribe error:', err);
        return false;
    }
}

export async function unsubscribeFromPush(): Promise<boolean> {
    try {
        const reg = await getRegistration();
        if (!reg) return true;

        const subscription = await reg.pushManager.getSubscription();
        if (!subscription) return true;

        // Remove from backend
        await authedFetch('/api/push-subscriptions', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
        });

        // Unsubscribe from browser
        await subscription.unsubscribe();
        console.log('[PushService] Unsubscribed from push');
        return true;
    } catch (err) {
        console.error('[PushService] Unsubscribe error:', err);
        return false;
    }
}

// ─── Status Check ────────────────────────────────────────────────────────────

export async function hasActiveSubscription(): Promise<boolean> {
    try {
        const reg = await getRegistration();
        if (!reg) return false;
        const sub = await reg.pushManager.getSubscription();
        return !!sub;
    } catch {
        return false;
    }
}

export async function sendTestNotification(): Promise<{ sent: number; failed: number }> {
    const res = await authedFetch('/api/push-subscriptions/test', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Test notification failed');
    return { sent: data.sent, failed: data.failed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBrowserName(): string {
    const ua = navigator.userAgent;
    if (ua.includes('Chrome') && !ua.includes('Edge')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
    if (ua.includes('Edge')) return 'Edge';
    return 'Unknown';
}

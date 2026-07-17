/**
 * Service Worker for Browser Push Notifications
 *
 * Handles push events and notification click deep links.
 * Registered from the frontend app for Web Push support.
 */

// ─── Push Event ─────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
    if (!event.data) return;

    let data;
    try {
        data = event.data.json();
    } catch {
        data = { title: 'Blanc', body: event.data.text() };
    }

    const options = {
        body: data.body || '',
        icon: '/vite.svg',
        badge: '/vite.svg',
        tag: data.tag || 'blanc-notification',
        data: {
            url: data.url || '/',
        },
        requireInteraction: false,
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'Blanc', options)
    );
});

// ─── Notification Click — Deep Link ─────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const targetUrl = event.notification.data?.url || '/';
    const fullUrl = new URL(targetUrl, self.location.origin).href;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // If app is already open, focus and navigate
            for (const client of windowClients) {
                if (client.url.startsWith(self.location.origin)) {
                    client.focus();
                    client.navigate(fullUrl);
                    return;
                }
            }
            // Otherwise open a new window
            return clients.openWindow(fullUrl);
        })
    );
});

// ─── Activate — claim clients immediately ────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

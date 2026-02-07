import React, { useEffect, useState } from 'react';
import './EventNotification.css';

interface EventData {
    call_sid: string;
    status: string;
    from?: string;
    to?: string;
    timestamp: string;
}

interface Notification {
    id: number;
    data: EventData;
}

export const EventNotification: React.FC = () => {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [nextId, setNextId] = useState(1);

    // Subscribe to window custom events
    useEffect(() => {
        const handleEvent = (e: CustomEvent) => {
            const notification: Notification = {
                id: nextId,
                data: e.detail
            };

            setNotifications(prev => [...prev, notification]);
            setNextId(prev => prev + 1);

            // Auto-remove after 5 seconds
            setTimeout(() => {
                setNotifications(prev => prev.filter(n => n.id !== notification.id));
            }, 5000);
        };

        window.addEventListener('sse-event-received' as any, handleEvent as EventListener);

        return () => {
            window.removeEventListener('sse-event-received' as any, handleEvent as EventListener);
        };
    }, [nextId]);

    if (notifications.length === 0) return null;

    return (
        <div className="event-notifications-container">
            {notifications.map(notification => (
                <div key={notification.id} className="event-notification">
                    <div className="notification-header">
                        <span className="notification-icon">📞</span>
                        <strong>SSE Event Received</strong>
                    </div>
                    <div className="notification-body">
                        <div className="notification-field">
                            <span className="field-label">Call SID:</span>
                            <span className="field-value">{notification.data.call_sid}</span>
                        </div>
                        <div className="notification-field">
                            <span className="field-label">Status:</span>
                            <span className="field-value status-badge">{notification.data.status}</span>
                        </div>
                        {notification.data.from && (
                            <div className="notification-field">
                                <span className="field-label">From:</span>
                                <span className="field-value">{notification.data.from}</span>
                            </div>
                        )}
                        <div className="notification-field">
                            <span className="field-label">Time:</span>
                            <span className="field-value">{new Date(notification.data.timestamp).toLocaleTimeString()}</span>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

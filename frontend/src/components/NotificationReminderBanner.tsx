import { useState, useEffect, useCallback } from 'react';
import { Bell, X } from 'lucide-react';
import { isSupported, getPermissionState, subscribeToPush } from '../services/pushNotificationService';
import { toast } from 'sonner';

// We store *which* permission state was active when the user dismissed.
// If the state later changes (e.g. granted→denied), the banner re-appears.
const DISMISSED_STATE_KEY = 'push-reminder-dismissed-state';

export default function NotificationReminderBanner() {
    const [visible, setVisible] = useState(false);
    const [permState, setPermState] = useState(getPermissionState());

    const evaluateVisibility = useCallback(() => {
        if (!isSupported()) return;
        const state = getPermissionState();
        setPermState(state);

        // Never show if already granted
        if (state === 'granted' || state === 'unsupported') {
            setVisible(false);
            return;
        }

        // Show if: never dismissed, OR permission changed since last dismiss
        const dismissedForState = sessionStorage.getItem(DISMISSED_STATE_KEY);
        if (!dismissedForState || dismissedForState !== state) {
            setVisible(true);
        }
    }, []);

    useEffect(() => {
        evaluateVisibility();

        // Re-check when the tab regains focus (user may have changed browser settings)
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                evaluateVisibility();
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        // Also poll every 5s in case the permission API changes without focus change
        const interval = setInterval(evaluateVisibility, 5000);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            clearInterval(interval);
        };
    }, [evaluateVisibility]);

    const dismiss = () => {
        // Remember which state we dismissed in, so we can re-show if it changes
        sessionStorage.setItem(DISMISSED_STATE_KEY, getPermissionState());
        setVisible(false);
    };

    const handleEnable = async () => {
        const ok = await subscribeToPush();
        if (ok) {
            toast.success('Browser notifications enabled!');
            setVisible(false);
        } else {
            setPermState(getPermissionState());
        }
    };

    if (!visible || permState === 'granted' || permState === 'unsupported') return null;

    return (
        <div className="bg-orange-50 border-b border-orange-100 px-4 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
                <Bell className="size-4 text-orange-500 shrink-0" />
                {permState === 'default' && (
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-sm text-gray-700">
                            Enable browser notifications to stay updated on new messages and leads.
                        </span>
                        <button
                            onClick={handleEnable}
                            className="px-2.5 py-1 bg-orange-500 text-white text-xs rounded hover:bg-orange-600 transition-colors whitespace-nowrap"
                        >
                            Enable notifications
                        </button>
                    </div>
                )}
                {permState === 'denied' && (
                    <div className="flex items-center gap-2 flex-wrap text-sm text-gray-700">
                        <span>Notifications are blocked.</span>
                        <span className="text-xs text-gray-500">Click the lock icon in the address bar → Notifications → Allow → Refresh the page.</span>
                    </div>
                )}
            </div>
            <button onClick={dismiss} className="text-gray-400 hover:text-gray-600 shrink-0">
                <X className="size-4" />
            </button>
        </div>
    );
}

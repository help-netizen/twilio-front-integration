import { useCallback, useEffect, useState } from 'react';
import { Bell, Share, PlusSquare } from 'lucide-react';
import { BottomSheet } from './ui/BottomSheet';
import { isBareRoute } from './layout/publicBareRoutes';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { isSupported, getPermissionState, subscribeToPush } from '../services/pushNotificationService';
import { getKeycloak } from '../auth/AuthProvider';

/**
 * PWA-INSTALL-PUSH-001 — mobile-web onboarding.
 *
 * On a mobile browser (not the already-installed standalone PWA) we invite the
 * user to install Albusto to their Home Screen, then to turn on push. It appears
 * on any route as soon as the CRM opens, as one expanded bottom-sheet.
 *
 *  - Android (Chrome): capture `beforeinstallprompt` → a real Install button.
 *  - iOS (Safari): no such event → show the Share → Add to Home Screen steps.
 *    iOS web-push only works inside the installed standalone PWA (iOS 16.4+),
 *    so the notification step is offered only once we detect standalone.
 *
 * Dismissal is remembered against the current login session, so a "Not now"
 * re-appears at the NEXT login (not nagging within the same session).
 */

// ─── environment detection ───────────────────────────────────────────────────
const mqMobile = () => window.matchMedia('(max-width: 767px)').matches;
const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari exposes this non-standard flag when launched from the Home Screen.
    (navigator as unknown as { standalone?: boolean }).standalone === true;
const isIOS = () =>
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports as MacIntel with touch.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ─── beforeinstallprompt capture (may fire before React mounts) ───────────────
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let capturedPrompt: InstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        capturedPrompt = e as InstallPromptEvent;
    });
}

// ─── dismissal keyed to the login session ─────────────────────────────────────
const DISMISS_KEY = 'pwa-onboarding-dismissed-session';
function currentSession(): string {
    try {
        const p = getKeycloak().tokenParsed as Record<string, unknown> | undefined;
        return String(p?.session_state || p?.sid || '');
    } catch {
        return '';
    }
}
const isDismissedForSession = () => {
    try { return localStorage.getItem(DISMISS_KEY) === currentSession() && currentSession() !== ''; } catch { return false; }
};

type Step = 'install' | 'notify' | null;

export default function InstallOnboardingSheet() {
    const [prompt, setPrompt] = useState<InstallPromptEvent | null>(capturedPrompt);
    const [step, setStep] = useState<Step>(null);
    const [busy, setBusy] = useState(false);

    const evaluate = useCallback(() => {
        if (!mqMobile() || isDismissedForSession()) { setStep(null); return; }
        if (!isStandalone()) {
            // Mobile browser → offer install. iOS always (instructions); Android only
            // once the native prompt is available.
            setStep(isIOS() || (capturedPrompt || prompt) ? 'install' : null);
            return;
        }
        // Installed standalone → offer notifications when they're actionable.
        setStep(isSupported() && getPermissionState() === 'default' ? 'notify' : null);
    }, [prompt]);

    useEffect(() => {
        evaluate();
        const onBIP = (e: Event) => { e.preventDefault(); capturedPrompt = e as InstallPromptEvent; setPrompt(capturedPrompt); };
        const onInstalled = () => { capturedPrompt = null; setPrompt(null); evaluate(); };
        window.addEventListener('beforeinstallprompt', onBIP);
        window.addEventListener('appinstalled', onInstalled);
        // Re-evaluate when the tab regains focus (permission may have changed,
        // or the token/session may have loaded).
        const onVisible = () => { if (document.visibilityState === 'visible') evaluate(); };
        document.addEventListener('visibilitychange', onVisible);
        const t = setTimeout(evaluate, 800); // catch a slightly-late token / BIP
        return () => {
            window.removeEventListener('beforeinstallprompt', onBIP);
            window.removeEventListener('appinstalled', onInstalled);
            document.removeEventListener('visibilitychange', onVisible);
            clearTimeout(t);
        };
    }, [evaluate]);

    const close = () => setStep(null);
    const dismiss = () => {
        try { localStorage.setItem(DISMISS_KEY, currentSession()); } catch { /* private mode */ }
        close();
    };

    const handleInstall = async () => {
        const p = prompt || capturedPrompt;
        if (!p) return;
        setBusy(true);
        try {
            await p.prompt();
            const choice = await p.userChoice;
            capturedPrompt = null; setPrompt(null);
            if (choice.outcome === 'accepted') {
                // Android push works in the browser too → move straight to notifications.
                if (isSupported() && getPermissionState() === 'default') { setStep('notify'); return; }
            }
            close();
        } catch {
            close();
        } finally { setBusy(false); }
    };

    const handleEnable = async () => {
        setBusy(true);
        try {
            const ok = await subscribeToPush();
            if (ok) toast.success('Notifications enabled');
            else if (getPermissionState() === 'denied') {
                toast.error('Notifications are blocked in your browser settings');
            }
        } catch {
            toast.error('Could not enable notifications');
        } finally { setBusy(false); close(); }
    };

    // Public customer-facing routes (pay links, estimates, Rate Me, signup)
    // must never pitch the internal CRM app install.
    if (isBareRoute(window.location.pathname)) return null;
    if (!step) return null;

    return (
        <BottomSheet open={!!step} onClose={dismiss} showHeader={false} size="auto" ariaLabel="Set up the Albusto app">
            <div className="mx-auto w-full max-w-[420px] px-1 pb-2 pt-1 text-center">
                {step === 'install' ? (
                    <>
                        <img
                            src="/icons/icon-192.png"
                            alt="Albusto"
                            className="mx-auto mb-3.5 h-14 w-14 rounded-[15px]"
                            style={{ boxShadow: '0 8px 20px rgba(127,66,225,.24)' }}
                        />
                        {isIOS() ? (
                            <>
                                <h2 className="blanc-heading mb-1.5 text-[21px] font-extrabold tracking-tight" style={{ color: 'var(--blanc-ink-1)' }}>
                                    Add Albusto to your Home Screen
                                </h2>
                                <p className="mx-auto mb-5 max-w-[300px] text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>
                                    Install it as an app for one-tap access and push notifications.
                                </p>
                                <div className="mb-1 text-left">
                                    <IosStep n={1}>Tap the <span className="mx-1 inline-grid h-[22px] w-[22px] place-items-center rounded-md" style={{ background: 'var(--blanc-surface-muted)', border: '1px solid var(--blanc-line)' }}><Share className="h-3.5 w-3.5" style={{ color: 'var(--blanc-accent)' }} /></span> Share icon</IosStep>
                                    <IosStep n={2}>Choose <b className="font-semibold">“Add to Home Screen”</b></IosStep>
                                    <IosStep n={3}>Tap <b className="font-semibold">“Add”</b></IosStep>
                                </div>
                                <p className="mb-4 mt-3.5 text-[12.5px] leading-snug" style={{ color: 'var(--blanc-ink-3)' }}>
                                    Then open Albusto from your Home Screen. Requires iOS 16.4 or later.
                                </p>
                                <Button className="w-full" onClick={dismiss}>Got it</Button>
                            </>
                        ) : (
                            <>
                                <h2 className="blanc-heading mb-1.5 text-[21px] font-extrabold tracking-tight" style={{ color: 'var(--blanc-ink-1)' }}>
                                    Install Albusto
                                </h2>
                                <p className="mx-auto mb-5 max-w-[300px] text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>
                                    Add Albusto to your Home Screen for one-tap access and push notifications for new jobs.
                                </p>
                                <Button className="w-full" disabled={busy} onClick={handleInstall}>
                                    <PlusSquare className="mr-1.5 h-4 w-4" /> Install app
                                </Button>
                            </>
                        )}
                        <button type="button" onClick={dismiss} className="mt-1.5 w-full py-2.5 text-sm font-medium" style={{ color: 'var(--blanc-ink-3)' }}>
                            Not now
                        </button>
                    </>
                ) : (
                    <>
                        <div className="mx-auto mb-3.5 grid h-14 w-14 place-items-center rounded-full" style={{ background: 'var(--blanc-accent-soft)' }}>
                            <Bell className="h-7 w-7" style={{ color: 'var(--blanc-accent)' }} />
                        </div>
                        <h2 className="blanc-heading mb-1.5 text-[21px] font-extrabold tracking-tight" style={{ color: 'var(--blanc-ink-1)' }}>
                            Turn on notifications
                        </h2>
                        <p className="mx-auto mb-5 max-w-[300px] text-sm leading-relaxed" style={{ color: 'var(--blanc-ink-2)' }}>
                            Get alerted the moment you’re assigned a new job or something needs your attention.
                        </p>
                        <Button className="w-full" disabled={busy} onClick={handleEnable}>
                            <Bell className="mr-1.5 h-4 w-4" /> Enable notifications
                        </Button>
                        <button type="button" onClick={dismiss} className="mt-1.5 w-full py-2.5 text-sm font-medium" style={{ color: 'var(--blanc-ink-3)' }}>
                            Not now
                        </button>
                    </>
                )}
            </div>
        </BottomSheet>
    );
}

function IosStep({ n, children }: { n: number; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-3 py-2.5" style={{ borderBottom: n < 3 ? '1px solid var(--blanc-line)' : 'none' }}>
            <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-full text-[13px] font-bold" style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)' }}>{n}</span>
            <span className="flex items-center text-[14.5px]" style={{ color: 'var(--blanc-ink-1)' }}>{children}</span>
        </div>
    );
}

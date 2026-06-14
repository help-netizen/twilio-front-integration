/**
 * twoFactorGate.ts — AUTH-2FA-GATE.
 *
 * Coordinates the global 2FA re-verification gate. When any authenticated
 * request returns 401 `PHONE_VERIFICATION_REQUIRED` (trusted-device cookie
 * expired, or a new device), authedFetch calls `requireTwoFactor()` which
 * surfaces the gate UI and resolves once the device is trusted again. The
 * original request is then retried — the user never sees a raw 401 or has to
 * re-login. Concurrent 401s share one in-flight verification (deduped).
 */

type Listener = (active: boolean) => void;

let pending: Promise<void> | null = null;
let resolvePending: (() => void) | null = null;
let rejectPending: ((err: unknown) => void) | null = null;
const listeners = new Set<Listener>();

/** Awaited by authedFetch on PHONE_VERIFICATION_REQUIRED. Dedupes concurrent calls. */
export function requireTwoFactor(): Promise<void> {
    if (!pending) {
        pending = new Promise<void>((resolve, reject) => {
            resolvePending = resolve;
            rejectPending = reject;
        });
        listeners.forEach((l) => l(true));
    }
    return pending;
}

/** Called by the gate UI once the device is trusted — unblocks all waiters. */
export function completeTwoFactor(): void {
    const r = resolvePending;
    pending = null;
    resolvePending = null;
    rejectPending = null;
    listeners.forEach((l) => l(false));
    r?.();
}

/** Called if the user abandons verification (e.g. logs out) — fails waiters. */
export function cancelTwoFactor(reason: unknown = new Error('2FA cancelled')): void {
    const r = rejectPending;
    pending = null;
    resolvePending = null;
    rejectPending = null;
    listeners.forEach((l) => l(false));
    r?.(reason);
}

/** The gate React component subscribes here to know when to show itself. */
export function subscribeTwoFactor(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

/** True while a verification is in flight (test/util helper). */
export function isTwoFactorActive(): boolean {
    return pending !== null;
}

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { CircleCheckBig, Loader2, LockKeyhole } from 'lucide-react';
import { Button } from '../ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogPanelHeader,
    DialogBody,
    DialogPanelFooter,
    DialogTitle,
} from '../ui/dialog';
import {
    invoiceStripeApi,
    jobStripeApi,
    stripePaymentsApi,
    type ManualCardSession,
    type ManualCardSessionResult,
} from '../../services/stripePaymentsApi';
import { loadStripe } from '../../utils/loadStripe';
import { formatSignedCurrency } from '../jobs/jobFinanceMath';

// Stripe.js does not expose a challenge-start callback. `submitting` is therefore
// the locked host state for both confirmation and its Stripe-owned 3DS substate.
export type ManualCardPhase = 'loading' | 'idle' | 'submitting' | 'declined' | 'network' | 'success';
type FinanceSyncState = 'updating' | 'updated' | 'delayed';

export interface ManualCardState {
    phase: ManualCardPhase;
    cardComplete: boolean;
    elementError: string | null;
    paymentError: string | null;
    networkChecking: boolean;
    result: ManualCardSessionResult | null;
    financeSync: FinanceSyncState;
}

type ManualCardAction =
    | { type: 'RESET' }
    | { type: 'SESSION_READY' }
    | { type: 'INITIALIZATION_FAILED'; message: string }
    | { type: 'CARD_CHANGE'; complete: boolean; error: string | null }
    | { type: 'SUBMIT' }
    | { type: 'VALIDATION_ERROR'; message: string }
    | { type: 'DECLINED'; message: string | null }
    | { type: 'NETWORK_CHECKING' }
    | { type: 'NETWORK_UNRESOLVED' }
    | { type: 'SUCCEEDED'; result: ManualCardSessionResult }
    | { type: 'RESULT_ENRICHED'; result: ManualCardSessionResult }
    | { type: 'FINANCE_SYNCED'; sync: Exclude<FinanceSyncState, 'updating'> };

export const INITIAL_MANUAL_CARD_STATE: ManualCardState = {
    phase: 'loading',
    cardComplete: false,
    elementError: null,
    paymentError: null,
    networkChecking: false,
    result: null,
    financeSync: 'updating',
};

export function manualCardReducer(state: ManualCardState, action: ManualCardAction): ManualCardState {
    switch (action.type) {
        case 'RESET':
            return INITIAL_MANUAL_CARD_STATE;
        case 'SESSION_READY':
            return { ...state, phase: 'idle', paymentError: null };
        case 'INITIALIZATION_FAILED':
            return { ...state, phase: 'idle', paymentError: action.message };
        case 'CARD_CHANGE':
            if (state.phase === 'submitting' || state.phase === 'network' || state.phase === 'success') return state;
            return { ...state, cardComplete: action.complete, elementError: action.error };
        case 'SUBMIT':
            if ((state.phase !== 'idle' && state.phase !== 'declined') || !state.cardComplete || state.elementError) return state;
            return { ...state, phase: 'submitting', paymentError: null };
        case 'VALIDATION_ERROR':
            return { ...state, phase: 'idle', paymentError: action.message };
        case 'DECLINED':
            return { ...state, phase: 'declined', paymentError: action.message, networkChecking: false };
        case 'NETWORK_CHECKING':
            return { ...state, phase: 'network', paymentError: null, networkChecking: true };
        case 'NETWORK_UNRESOLVED':
            return { ...state, phase: 'network', networkChecking: false };
        case 'SUCCEEDED':
            return {
                ...state,
                phase: 'success',
                networkChecking: false,
                paymentError: null,
                result: action.result,
                financeSync: 'updating',
            };
        case 'RESULT_ENRICHED':
            return state.phase === 'success' && action.result.status === 'succeeded'
                ? { ...state, result: action.result }
                : state;
        case 'FINANCE_SYNCED':
            return state.phase === 'success' ? { ...state, financeSync: action.sync } : state;
    }
}

export function canDismissManualCard(phase: ManualCardPhase): boolean {
    return phase === 'loading' || phase === 'idle' || phase === 'declined';
}

export function requestManualCardDismiss(phase: ManualCardPhase, onOpenChange: (open: boolean) => void): void {
    if (canDismissManualCard(phase)) onOpenChange(false);
}

export function completeManualCardDialog(onOpenChange: (open: boolean) => void, onDone?: () => void): void {
    onOpenChange(false);
    onDone?.();
}

export async function settleFinanceSync(
    result: ManualCardSessionResult,
    onPaymentConfirmed?: (payment: ManualCardSessionResult) => boolean | void | Promise<boolean | void>,
): Promise<Exclude<FinanceSyncState, 'updating'>> {
    if (!onPaymentConfirmed) return 'delayed';
    try {
        return await onPaymentConfirmed(result) === true ? 'updated' : 'delayed';
    } catch {
        return 'delayed';
    }
}

function tokenValue(name: string): string {
    if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return '';
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function createCardElementOptions() {
    const ink = tokenValue('--blanc-ink-1');
    const muted = tokenValue('--blanc-ink-3');
    const danger = tokenValue('--blanc-danger');
    const fontFamily = tokenValue('--blanc-font-body');
    const base: Record<string, unknown> = {
        fontSize: '16px',
        fontSmoothing: 'antialiased',
        ...(ink ? { color: ink } : {}),
        ...(fontFamily ? { fontFamily } : {}),
        ...(muted ? { '::placeholder': { color: muted } } : {}),
    };

    return {
        hidePostalCode: false,
        style: {
            base,
            invalid: danger ? { color: danger } : {},
        },
    };
}

interface StripeCardChangeEvent {
    complete: boolean;
    error?: { message?: string };
}

interface StripeCardHandlers {
    onChange: (event: StripeCardChangeEvent) => void;
    onFocus: () => void;
    onBlur: () => void;
}

export function mountStripeCard(
    stripe: any,
    clientSecret: string,
    mountNode: HTMLDivElement,
    handlers: StripeCardHandlers,
) {
    const elements = stripe.elements({ clientSecret, locale: 'en' });
    const card = elements.create('card', createCardElementOptions());
    card.on('change', handlers.onChange);
    card.on('focus', handlers.onFocus);
    card.on('blur', handlers.onBlur);
    card.mount(mountNode);

    let destroyed = false;
    return {
        card,
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            card.off?.('change', handlers.onChange);
            card.off?.('focus', handlers.onFocus);
            card.off?.('blur', handlers.onBlur);
            if (card.destroy) card.destroy();
            else card.unmount?.();
        },
    };
}

type ConfirmationDecision =
    | { kind: 'succeeded' }
    | { kind: 'declined'; message: string | null }
    | { kind: 'validation'; message: string }
    | { kind: 'unknown' };

export function decideConfirmation(response: any): ConfirmationDecision {
    const status = response?.paymentIntent?.status || response?.error?.payment_intent?.status;
    if (status === 'succeeded') return { kind: 'succeeded' };
    if (status === 'requires_payment_method') {
        return { kind: 'declined', message: response?.error?.message || null };
    }
    if (response?.error?.type === 'validation_error') {
        return { kind: 'validation', message: response.error.message || 'Check the card details and try again.' };
    }
    return { kind: 'unknown' };
}

export const RESULT_RECONCILE_DELAYS_MS = [0, 1000, 2000, 4000, 8000] as const;

interface ReconcileOptions {
    sessionId: number;
    getResult: (sessionId: number) => Promise<ManualCardSessionResult>;
    wait: (milliseconds: number) => Promise<void>;
    isCancelled?: () => boolean;
    delays?: readonly number[];
}

export async function reconcileManualCardSession({
    sessionId,
    getResult,
    wait,
    isCancelled = () => false,
    delays = RESULT_RECONCILE_DELAYS_MS,
}: ReconcileOptions): Promise<ManualCardSessionResult | null> {
    for (const delay of delays) {
        if (delay > 0) await wait(delay);
        if (isCancelled()) return null;
        try {
            const result = await getResult(sessionId);
            if (result.status === 'succeeded' || result.status === 'requires_payment_method') return result;
        } catch {
            // An unavailable result remains ambiguous; keep the same PI locked and retry.
        }
    }
    return null;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoiceId?: number;
    jobId?: number | string;
    amount?: number;
    balanceBefore?: number;
    jobHasInvoices?: boolean;
    onPaymentConfirmed?: (payment: ManualCardSessionResult) => boolean | void | Promise<boolean | void>;
    onDone?: () => void;
}

/** Stripe-hosted keyed card entry. PAN, expiry, CVC, and ZIP never enter React state or Albusto APIs. */
export default function ManualCardDialog({
    open,
    onOpenChange,
    invoiceId,
    jobId,
    amount,
    balanceBefore,
    jobHasInvoices,
    onPaymentConfirmed,
    onDone,
}: Props) {
    const mountRef = useRef<HTMLDivElement>(null);
    const stripeRef = useRef<any>(null);
    const cardRef = useRef<any>(null);
    const sessionRef = useRef<ManualCardSession | null>(null);
    const mountedCardRef = useRef<{ destroy: () => void } | null>(null);
    const submitLockRef = useRef(false);
    const reconcileRunningRef = useRef(false);
    const confirmedSessionRef = useRef<number | null>(null);
    const initialBalanceRef = useRef<number | undefined>(balanceBefore);
    const flowIdRef = useRef(0);
    const waitersRef = useRef(new Map<number, () => void>());
    const [state, dispatch] = useReducer(manualCardReducer, INITIAL_MANUAL_CARD_STATE);
    const [displayAmount, setDisplayAmount] = useState<number | null>(amount ?? null);
    const [cardFocused, setCardFocused] = useState(false);

    const cancelWaits = useCallback(() => {
        for (const cancel of waitersRef.current.values()) cancel();
        waitersRef.current.clear();
    }, []);

    const wait = useCallback((milliseconds: number) => new Promise<void>(resolve => {
        const id = window.setTimeout(() => {
            waitersRef.current.delete(id);
            resolve();
        }, milliseconds);
        waitersRef.current.set(id, () => {
            window.clearTimeout(id);
            resolve();
        });
    }), []);

    useEffect(() => {
        if (!open) {
            flowIdRef.current += 1;
            cancelWaits();
            dispatch({ type: 'RESET' });
            setDisplayAmount(amount ?? null);
            setCardFocused(false);
            return;
        }

        const flowId = ++flowIdRef.current;
        let cancelled = false;
        dispatch({ type: 'RESET' });
        setDisplayAmount(amount ?? null);
        // Freeze the pre-charge Due for success copy. Parent polling will soon pass the
        // post-charge balance; reading that live would subtract this payment twice.
        initialBalanceRef.current = balanceBefore;
        submitLockRef.current = false;
        reconcileRunningRef.current = false;
        confirmedSessionRef.current = null;

        (async () => {
            try {
                const session = jobId != null
                    ? await jobStripeApi.manualCardSession(jobId, amount)
                    : await invoiceStripeApi.manualCardSession(invoiceId!, amount);
                const stripe = await loadStripe(session.account_id);
                if (cancelled || flowId !== flowIdRef.current || !mountRef.current) return;

                const mounted = mountStripeCard(stripe, session.client_secret, mountRef.current, {
                    onChange: event => dispatch({
                        type: 'CARD_CHANGE',
                        complete: event.complete,
                        error: event.error?.message || null,
                    }),
                    onFocus: () => setCardFocused(true),
                    onBlur: () => setCardFocused(false),
                });
                stripeRef.current = stripe;
                cardRef.current = mounted.card;
                sessionRef.current = session;
                mountedCardRef.current = mounted;
                setDisplayAmount(session.amount);
                dispatch({ type: 'SESSION_READY' });
            } catch (error: any) {
                if (cancelled || flowId !== flowIdRef.current) return;
                const message = String(error?.message || 'Could not start card entry');
                dispatch({
                    type: 'INITIALIZATION_FAILED',
                    message: /not ready|NOT_READY/i.test(message)
                        ? 'Connect Stripe in Integrations first.'
                        : message,
                });
            }
        })();

        return () => {
            cancelled = true;
            flowIdRef.current += 1;
            cancelWaits();
            mountedCardRef.current?.destroy();
            mountedCardRef.current = null;
            stripeRef.current = null;
            cardRef.current = null;
            sessionRef.current = null;
            submitLockRef.current = false;
            reconcileRunningRef.current = false;
        };
    }, [open, invoiceId, jobId, amount, cancelWaits]);

    const locked = state.phase === 'submitting' || state.phase === 'network' || state.phase === 'success';
    useEffect(() => {
        cardRef.current?.update?.({ disabled: locked });
    }, [locked]);

    const enterSuccess = useCallback((result: ManualCardSessionResult) => {
        if (result.status !== 'succeeded') return;
        const sessionId = sessionRef.current?.session_id;
        if (sessionId == null || confirmedSessionRef.current === sessionId) return;
        confirmedSessionRef.current = sessionId;
        submitLockRef.current = true;
        const flowId = flowIdRef.current;
        dispatch({ type: 'SUCCEEDED', result });
        void settleFinanceSync(result, onPaymentConfirmed).then(sync => {
            if (flowId === flowIdRef.current) dispatch({ type: 'FINANCE_SYNCED', sync });
        });
    }, [onPaymentConfirmed]);

    const reconcile = useCallback(async () => {
        const session = sessionRef.current;
        if (!session || reconcileRunningRef.current) return;
        reconcileRunningRef.current = true;
        submitLockRef.current = true;
        dispatch({ type: 'NETWORK_CHECKING' });
        const flowId = flowIdRef.current;
        const result = await reconcileManualCardSession({
            sessionId: session.session_id,
            getResult: stripePaymentsApi.getManualCardSessionResult,
            wait,
            isCancelled: () => flowId !== flowIdRef.current,
        });
        if (flowId !== flowIdRef.current) return;
        reconcileRunningRef.current = false;
        if (result?.status === 'succeeded') {
            enterSuccess(result);
            return;
        }
        if (result?.status === 'requires_payment_method') {
            submitLockRef.current = false;
            dispatch({ type: 'DECLINED', message: null });
            return;
        }
        dispatch({ type: 'NETWORK_UNRESOLVED' });
    }, [enterSuccess, wait]);

    const submit = useCallback(async () => {
        const stripe = stripeRef.current;
        const card = cardRef.current;
        const session = sessionRef.current;
        if (!stripe || !card || !session || !state.cardComplete || state.elementError || submitLockRef.current) return;

        submitLockRef.current = true;
        dispatch({ type: 'SUBMIT' });
        try {
            const response = await stripe.confirmCardPayment(session.client_secret, {
                payment_method: { card },
            });
            const decision = decideConfirmation(response);
            if (decision.kind === 'succeeded') {
                const result: ManualCardSessionResult = {
                    status: 'succeeded',
                    amount: session.amount,
                    brand: null,
                    last4: null,
                };
                enterSuccess(result);
                const flowId = flowIdRef.current;
                void stripePaymentsApi.getManualCardSessionResult(session.session_id)
                    .then(enriched => {
                        if (flowId === flowIdRef.current && enriched.status === 'succeeded') {
                            dispatch({ type: 'RESULT_ENRICHED', result: enriched });
                        }
                    })
                    .catch(() => {
                        // confirmCardPayment already returned the authoritative succeeded status.
                    });
                return;
            }
            if (decision.kind === 'validation') {
                submitLockRef.current = false;
                dispatch({ type: 'VALIDATION_ERROR', message: decision.message });
                return;
            }
            if (decision.kind === 'declined') {
                submitLockRef.current = false;
                dispatch({ type: 'DECLINED', message: decision.message });
                return;
            }
            await reconcile();
        } catch {
            await reconcile();
        }
    }, [enterSuccess, reconcile, state.cardComplete, state.elementError]);

    const amountText = formatSignedCurrency(displayAmount ?? 0);
    const projectedDue = state.result && initialBalanceRef.current != null
        ? initialBalanceRef.current - state.result.amount
        : null;
    const cardLabel = state.result?.brand && state.result.last4
        ? `${state.result.brand.charAt(0).toUpperCase()}${state.result.brand.slice(1)} •••• ${state.result.last4}`
        : null;
    const contextLabel = jobId != null ? `Job ${jobId}` : 'Invoice';
    const cardBorder = state.elementError
        ? 'var(--blanc-danger)'
        : cardFocused
            ? 'var(--blanc-accent)'
            : 'transparent';

    const handleDialogOpenChange = (nextOpen: boolean) => {
        if (nextOpen) onOpenChange(true);
        else requestManualCardDismiss(state.phase, onOpenChange);
    };

    return (
        <Dialog open={open} onOpenChange={handleDialogOpenChange}>
            <DialogContent
                variant="panel"
                onEscapeKeyDown={event => { if (!canDismissManualCard(state.phase)) event.preventDefault(); }}
                onInteractOutside={event => { if (!canDismissManualCard(state.phase)) event.preventDefault(); }}
            >
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Charge card
                    </DialogTitle>
                    <p className="text-sm text-[var(--blanc-ink-2)]">
                        {contextLabel}{displayAmount != null && <> · <strong className="text-[var(--blanc-ink-1)]">{amountText}</strong></>}
                    </p>
                    <DialogDescription className="sr-only">Charge a card through Stripe's secure card fields</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {state.phase !== 'success' ? (
                            <>
                                <div className="flex items-start gap-3 rounded-2xl bg-[var(--blanc-accent-soft)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]">
                                    <LockKeyhole className="mt-0.5 size-4 shrink-0 text-[var(--blanc-accent)]" aria-hidden="true" />
                                    <span>Card details are encrypted and sent directly to Stripe. Albusto never sees the card number.</span>
                                </div>

                                {state.phase === 'loading' && !state.paymentError && (
                                    <div className="flex items-center gap-2 py-6 text-sm text-[var(--blanc-ink-2)]">
                                        <Loader2 className="size-4 animate-spin" /> Preparing secure form…
                                    </div>
                                )}

                                <div className={`space-y-2 ${state.phase === 'loading' ? 'pointer-events-none opacity-0' : ''}`}>
                                    <div
                                        ref={mountRef}
                                        aria-label="Card number, MM/YY, CVC, ZIP"
                                        className={`min-h-[52px] rounded-[10px] px-4 py-[17px] transition-opacity ${locked ? 'pointer-events-none opacity-60' : ''}`}
                                        style={{
                                            background: 'var(--blanc-field)',
                                            border: `1.5px solid ${cardBorder}`,
                                        }}
                                    />
                                    <p className="text-xs text-[var(--blanc-ink-3)]">Secure card fields by Stripe</p>
                                </div>

                                {state.elementError && (
                                    <p className="text-sm text-[var(--blanc-danger)]" role="alert">{state.elementError}</p>
                                )}
                                {state.phase === 'idle' && state.paymentError && (
                                    <p className="text-sm text-[var(--blanc-danger)]" role="alert">{state.paymentError}</p>
                                )}

                                {state.phase === 'declined' && (
                                    <div className="space-y-1 rounded-2xl bg-[var(--blanc-field)] px-4 py-3 text-sm" role="alert">
                                        <strong className="block text-[var(--blanc-danger)]">Card declined</strong>
                                        {state.paymentError && <span className="block text-[var(--blanc-ink-2)]">{state.paymentError}</span>}
                                        <span className="block text-[var(--blanc-ink-2)]">Ask for another card or check the details, then try again. No payment was taken.</span>
                                    </div>
                                )}

                                {state.phase === 'network' && (
                                    <div className="space-y-1 rounded-2xl bg-[var(--blanc-field)] px-4 py-3 text-sm" role="alert">
                                        <strong className="block text-[var(--blanc-danger)]">We couldn’t confirm the result</strong>
                                        <span className="block text-[var(--blanc-ink-2)]">We’re checking Stripe before another charge is allowed. Don’t retry yet.</span>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="flex flex-col items-center py-8 text-center">
                                <CircleCheckBig className="size-16 text-[var(--blanc-success)]" strokeWidth={1.6} aria-hidden="true" />
                                <p className="blanc-eyebrow mt-5">Payment complete</p>
                                <h2 className="mt-2 text-2xl font-semibold text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>
                                    Payment successful
                                </h2>
                                <p className="mt-3 text-xl font-semibold text-[var(--blanc-ink-1)]">Paid {formatSignedCurrency(state.result?.amount)}</p>
                                {cardLabel && <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">{cardLabel}</p>}
                                <p className="mt-5 text-sm font-medium text-[var(--blanc-success)]">
                                    {state.financeSync === 'updating' && 'Updating Finance…'}
                                    {state.financeSync === 'updated' && (projectedDue != null
                                        ? `Finance updated · Due ${formatSignedCurrency(projectedDue)}`
                                        : 'Finance updated.')}
                                    {state.financeSync === 'delayed' && 'Payment is confirmed. Finance may take a moment to update.'}
                                </p>
                                <p className="mt-3 max-w-md text-sm text-[var(--blanc-ink-2)]">
                                    {jobId != null && !jobHasInvoices && projectedDue != null && projectedDue < 0
                                        ? `The payment is recorded on Job ${jobId} as a credit because there is no invoice.`
                                        : jobId != null
                                            ? `The payment is recorded on Job ${jobId}.`
                                            : 'The payment is recorded on this invoice.'}
                                </p>
                            </div>
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    {state.phase === 'success' ? (
                        <Button onClick={() => completeManualCardDialog(onOpenChange, onDone)}>Done</Button>
                    ) : (
                        <>
                            <Button
                                variant="ghost"
                                onClick={() => requestManualCardDismiss(state.phase, onOpenChange)}
                                disabled={state.phase === 'submitting' || state.phase === 'network'}
                            >
                                Cancel
                            </Button>
                            {state.phase === 'network' ? (
                                <Button onClick={() => void reconcile()} disabled={state.networkChecking}>
                                    {state.networkChecking && <Loader2 className="mr-2 size-4 animate-spin" />}
                                    {state.networkChecking ? 'Checking status…' : 'Check status'}
                                </Button>
                            ) : (
                                <Button
                                    onClick={() => void submit()}
                                    disabled={state.phase === 'loading' || state.phase === 'submitting' || !state.cardComplete || !!state.elementError}
                                >
                                    {state.phase === 'submitting' && <Loader2 className="mr-2 size-4 animate-spin" />}
                                    {state.phase === 'submitting'
                                        ? `Charging ${amountText}…`
                                        : state.phase === 'declined'
                                            ? 'Try again'
                                            : `Charge ${amountText}`}
                                </Button>
                            )}
                        </>
                    )}
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { CircleCheckBig, Loader2, LockKeyhole, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
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
    type ManualCardConfirmation,
    type ManualCardSession,
    type ManualCardSessionResult,
} from '../../services/stripePaymentsApi';
import {
    CardEntryPopupBlockedError,
    launchCardEntryPopup,
    type CardEntryPopupHandle,
    type CardEntryPopupLaunchOptions,
} from '../../card-entry/opener';
import type {
    CardframePaymentMethodMessage,
    CardframeResultMessage,
} from '../../card-entry/protocol';
import { formatSignedCurrency } from '../jobs/jobFinanceMath';

export type ManualCardPhase =
    | 'loading'
    | 'idle'
    | 'collecting'
    | 'charging'
    | 'authenticating'
    | 'declined'
    | 'network'
    | 'success';
type FinanceSyncState = 'updating' | 'updated' | 'delayed';
export type ManualCardReceiptPhase = 'idle' | 'sending' | 'sent' | 'error';

export interface ManualCardReceiptState {
    phase: ManualCardReceiptPhase;
    email: string;
    sentEmail: string | null;
    error: string | null;
    dirty: boolean;
}

type ManualCardReceiptAction =
    | { type: 'RESET'; email: string }
    | { type: 'PREFILL'; email: string }
    | { type: 'EDIT'; email: string }
    | { type: 'SEND' }
    | { type: 'SENT'; email: string }
    | { type: 'ERROR'; message: string };

export function createManualCardReceiptState(email = ''): ManualCardReceiptState {
    return { phase: 'idle', email: email.trim(), sentEmail: null, error: null, dirty: false };
}

export function manualCardReceiptReducer(
    state: ManualCardReceiptState,
    action: ManualCardReceiptAction,
): ManualCardReceiptState {
    switch (action.type) {
        case 'RESET':
            return createManualCardReceiptState(action.email);
        case 'PREFILL':
            return state.phase === 'idle' && !state.dirty
                ? { ...state, email: action.email.trim() }
                : state;
        case 'EDIT':
            if (state.phase === 'sending' || state.phase === 'sent') return state;
            return { ...state, phase: 'idle', email: action.email, error: null, dirty: true };
        case 'SEND':
            if (state.phase === 'sending' || state.phase === 'sent') return state;
            return { ...state, phase: 'sending', error: null };
        case 'SENT':
            return { ...state, phase: 'sent', email: action.email, sentEmail: action.email, error: null };
        case 'ERROR':
            return { ...state, phase: 'error', error: action.message };
        default:
            return state;
    }
}

export function shouldShowReceiptContactSaveCaption(
    hasContact: boolean | undefined,
    contactEmail: string | null | undefined,
    phase: ManualCardReceiptPhase,
): boolean {
    return Boolean(
        hasContact
        && contactEmail !== undefined
        && !String(contactEmail || '').trim()
        && phase !== 'sent'
    );
}

const RECEIPT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateReceiptEmail(value: string): string | null {
    const email = value.trim();
    return email.length > 0 && email.length <= 254 && RECEIPT_EMAIL_SHAPE.test(email)
        ? null
        : 'Enter a valid customer email.';
}

export interface ManualCardState {
    phase: ManualCardPhase;
    paymentError: string | null;
    networkChecking: boolean;
    result: ManualCardSessionResult | null;
    financeSync: FinanceSyncState;
}

type ManualCardAction =
    | { type: 'RESET'; force?: boolean }
    | { type: 'SESSION_READY' }
    | { type: 'INITIALIZATION_FAILED'; message: string }
    | { type: 'COLLECT' }
    | { type: 'CARD_SELECTED' }
    | { type: 'CHARGE' }
    | { type: 'AUTHENTICATE' }
    | { type: 'POPUP_CANCELED' }
    | { type: 'DECLINED'; message: string | null }
    | { type: 'NETWORK_CHECKING' }
    | { type: 'NETWORK_UNRESOLVED' }
    | { type: 'SUCCEEDED'; result: ManualCardSessionResult }
    | { type: 'FINANCE_SYNCED'; sync: Exclude<FinanceSyncState, 'updating'> };

export const INITIAL_MANUAL_CARD_STATE: ManualCardState = {
    phase: 'loading',
    paymentError: null,
    networkChecking: false,
    result: null,
    financeSync: 'updating',
};

export function manualCardReducer(state: ManualCardState, action: ManualCardAction): ManualCardState {
    if (
        state.phase === 'success'
        && action.type !== 'FINANCE_SYNCED'
        && !(action.type === 'RESET' && action.force)
    ) {
        return state;
    }

    switch (action.type) {
        case 'RESET':
            return INITIAL_MANUAL_CARD_STATE;
        case 'SESSION_READY':
            return { ...state, phase: 'idle', paymentError: null };
        case 'INITIALIZATION_FAILED':
            return { ...state, phase: 'idle', paymentError: action.message };
        case 'COLLECT':
            if (state.phase !== 'idle' && state.phase !== 'declined') return state;
            return { ...state, phase: 'collecting', paymentError: null };
        case 'CARD_SELECTED':
            return { ...state, phase: 'idle', paymentError: null };
        case 'CHARGE':
            if (state.phase !== 'idle' && state.phase !== 'declined') return state;
            return { ...state, phase: 'charging', paymentError: null };
        case 'AUTHENTICATE':
            return { ...state, phase: 'authenticating', paymentError: null };
        case 'POPUP_CANCELED':
            return { ...state, phase: 'idle', paymentError: null, networkChecking: false };
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
        case 'FINANCE_SYNCED':
            return state.phase === 'success' ? { ...state, financeSync: action.sync } : state;
    }
}

function claimManualCardSuccessSession(
    result: ManualCardSessionResult,
    sessionId: number | null,
    confirmedSessionId: number | null,
): number | null {
    if (
        result.status !== 'succeeded'
        || sessionId == null
        || confirmedSessionId === sessionId
    ) {
        return null;
    }
    return sessionId;
}

export function commitManualCardSuccess(
    result: ManualCardSessionResult,
    sessionId: number,
    confirmedSessionRef: { current: number | null },
    onSucceeded: (result: ManualCardSessionResult) => void,
): boolean {
    const claimedSessionId = claimManualCardSuccessSession(
        result,
        sessionId,
        confirmedSessionRef.current,
    );
    if (claimedSessionId == null) return false;
    confirmedSessionRef.current = claimedSessionId;
    onSucceeded(result);
    return true;
}

interface ManualCardSuccessViewProps {
    result: ManualCardSessionResult;
    cardLabel: string | null;
    receiptState: ManualCardReceiptState;
    receiptLocked: boolean;
    showContactSaveCaption: boolean;
    onReceiptEmailChange: (email: string) => void;
    onSendReceipt: () => void;
}

export function ManualCardSuccessView({
    result,
    cardLabel,
    receiptState,
    receiptLocked,
    showContactSaveCaption,
    onReceiptEmailChange,
    onSendReceipt,
}: ManualCardSuccessViewProps) {
    const receiptSent = receiptState.phase === 'sent' && Boolean(receiptState.sentEmail);
    return (
        <div className="flex flex-col items-center py-8 text-center">
            <CircleCheckBig className="size-16 text-[var(--blanc-success)]" strokeWidth={1.6} aria-hidden="true" />
            <h2 className="mt-4 text-2xl font-semibold text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>
                Payment successful
            </h2>
            <p className="mt-3 text-xl font-semibold text-[var(--blanc-ink-1)]">Paid {formatSignedCurrency(result.amount)}</p>
            {cardLabel && <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">{cardLabel}</p>}

            <div className="mt-6 w-full max-w-md space-y-3.5 text-left">
                {receiptSent ? (
                    <p className="flex items-center justify-center gap-2 text-sm font-medium text-[var(--blanc-success)]" role="status">
                        <CircleCheckBig className="size-4 shrink-0" aria-hidden="true" />
                        <span>Receipt sent to {receiptState.sentEmail}</span>
                    </p>
                ) : (
                    <>
                        <FloatingField
                            label="Customer email"
                            type="email"
                            inputMode="email"
                            value={receiptState.email}
                            onChange={event => onReceiptEmailChange(event.target.value)}
                            disabled={receiptLocked}
                        />
                        {showContactSaveCaption && (
                            <p className="text-xs text-[var(--blanc-ink-3)]">
                                This email will be saved to the customer's contact.
                            </p>
                        )}
                        <Button
                            type="button"
                            variant="secondary"
                            className="w-full"
                            onClick={onSendReceipt}
                            disabled={receiptLocked || !receiptState.email.trim()}
                        >
                            {receiptState.phase === 'sending' && <Loader2 className="size-4 animate-spin" />}
                            {receiptState.phase === 'sending' ? 'Sending receipt…' : 'Send receipt'}
                        </Button>
                        {receiptState.error && (
                            <p className="text-sm text-[var(--blanc-danger)]" role="alert">{receiptState.error}</p>
                        )}
                    </>
                )}
            </div>
        </div>
    );
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

interface HandleCardEntryPopupResultOptions {
    popupResult: CardframeResultMessage;
    sessionId: number;
    succeededFallback: Omit<ManualCardSessionResult, 'status'>;
    getResult: (sessionId: number) => Promise<ManualCardSessionResult>;
    wait: (milliseconds: number) => Promise<void>;
    isCancelled?: () => boolean;
    onSucceeded: (result: ManualCardSessionResult) => void | Promise<void>;
    onDeclined: (message: string | null) => void;
    onUnresolved: () => void;
    delays?: readonly number[];
}

export async function handleCardEntryPopupResult({
    popupResult,
    sessionId,
    succeededFallback,
    getResult,
    wait,
    isCancelled = () => false,
    onSucceeded,
    onDeclined,
    onUnresolved,
    delays,
}: HandleCardEntryPopupResultOptions): Promise<void> {
    if (popupResult.status === 'canceled' || isCancelled()) return;
    const result = await reconcileManualCardSession({
        sessionId,
        getResult,
        wait,
        isCancelled,
        ...(delays ? { delays } : {}),
    });
    if (isCancelled()) return;
    if (popupResult.status === 'succeeded') {
        await onSucceeded(result?.status === 'succeeded'
            ? result
            : { ...succeededFallback, status: 'succeeded' });
        return;
    }
    if (result?.status === 'succeeded') {
        await onSucceeded(result);
        return;
    }
    if (result?.status === 'requires_payment_method') {
        onDeclined(popupResult.message || null);
        return;
    }
    onUnresolved();
}

export function openManualCardEntryPopup(
    session: ManualCardSession,
    onCopyLinkFallback?: () => void | Promise<void>,
    options?: CardEntryPopupLaunchOptions,
): CardEntryPopupHandle | null {
    try {
        return launchCardEntryPopup({
            mode: 'collect',
            accountId: session.account_id,
            amount: session.amount,
        }, options);
    } catch (error) {
        if (!(error instanceof CardEntryPopupBlockedError)) throw error;
        toast.error('Pop-up blocked. Allow pop-ups to enter card details.', {
            ...(onCopyLinkFallback ? {
                action: {
                    label: 'Copy link instead',
                    onClick: () => { void onCopyLinkFallback(); },
                },
            } : {}),
        });
        return null;
    }
}

export function openManualCardAuthenticationPopup(
    session: ManualCardSession,
    clientSecret: string,
    onCopyLinkFallback?: () => void | Promise<void>,
    options?: CardEntryPopupLaunchOptions,
): CardEntryPopupHandle | null {
    try {
        return launchCardEntryPopup({
            mode: 'authenticate',
            accountId: session.account_id,
            amount: session.amount,
            clientSecret,
        }, options);
    } catch (error) {
        if (!(error instanceof CardEntryPopupBlockedError)) throw error;
        toast.error('Pop-up blocked. Allow pop-ups to verify the card.', {
            ...(onCopyLinkFallback ? {
                action: {
                    label: 'Copy link instead',
                    onClick: () => { void onCopyLinkFallback(); },
                },
            } : {}),
        });
        return null;
    }
}

export type ManualCardChargeOutcome =
    | { status: 'succeeded' }
    | { status: 'canceled' }
    | { status: 'popup_blocked' }
    | { status: 'failed'; message: string | null };

interface RunManualCardChargeOptions {
    session: ManualCardSession;
    paymentMethodId: string;
    confirmSession: (
        sessionId: number,
        paymentMethodId: string,
    ) => Promise<ManualCardConfirmation>;
    finalizeSession: (sessionId: number) => Promise<ManualCardConfirmation>;
    openAuthentication: (clientSecret: string) => CardEntryPopupHandle | null;
    onAuthenticationStarted?: () => void;
}

export async function runManualCardCharge({
    session,
    paymentMethodId,
    confirmSession,
    finalizeSession,
    openAuthentication,
    onAuthenticationStarted,
}: RunManualCardChargeOptions): Promise<ManualCardChargeOutcome> {
    const confirmation = await confirmSession(session.session_id, paymentMethodId);
    if (confirmation.status === 'succeeded') return { status: 'succeeded' };

    onAuthenticationStarted?.();
    const handle = openAuthentication(confirmation.clientSecret);
    if (!handle) return { status: 'popup_blocked' };
    const popupResult = await handle.result;
    if (popupResult.kind !== 'cardframe:result') {
        return { status: 'failed', message: 'Card verification returned an unexpected result.' };
    }
    if (popupResult.status === 'canceled') return { status: 'canceled' };
    if (popupResult.status !== 'succeeded') {
        return { status: 'failed', message: popupResult.message || null };
    }

    const finalized = await finalizeSession(session.session_id);
    return finalized.status === 'succeeded'
        ? { status: 'succeeded' }
        : { status: 'failed', message: 'Card verification is not complete.' };
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invoiceId?: number;
    jobId?: number | string;
    amount?: number;
    balanceBefore?: number;
    jobHasInvoices?: boolean;
    contactEmail?: string | null;
    hasContact?: boolean;
    onPaymentConfirmed?: (payment: ManualCardSessionResult) => boolean | void | Promise<boolean | void>;
    onDone?: () => void;
    onCopyLinkFallback?: () => void | Promise<void>;
}

/** Opens Stripe-hosted keyed card entry in a separate top-level browsing context. */
export default function ManualCardDialog({
    open,
    onOpenChange,
    invoiceId,
    jobId,
    amount,
    balanceBefore,
    contactEmail,
    hasContact,
    onPaymentConfirmed,
    onDone,
    onCopyLinkFallback,
}: Props) {
    const sessionRef = useRef<ManualCardSession | null>(null);
    const popupHandleRef = useRef<CardEntryPopupHandle | null>(null);
    const submitLockRef = useRef(false);
    const receiptSendingRef = useRef(false);
    const reconcileRunningRef = useRef(false);
    const confirmedSessionRef = useRef<number | null>(null);
    const initialBalanceRef = useRef<number | undefined>(balanceBefore);
    const sessionRequestRef = useRef({
        invoiceId,
        jobId,
        amount,
        balanceBefore,
        contactEmail,
    });
    sessionRequestRef.current = {
        invoiceId,
        jobId,
        amount,
        balanceBefore,
        contactEmail,
    };
    const flowIdRef = useRef(0);
    const waitersRef = useRef(new Map<number, () => void>());
    const [state, dispatch] = useReducer(manualCardReducer, INITIAL_MANUAL_CARD_STATE);
    const [receiptState, receiptDispatch] = useReducer(
        manualCardReceiptReducer,
        contactEmail || '',
        createManualCardReceiptState,
    );
    const [displayAmount, setDisplayAmount] = useState<number | null>(amount ?? null);
    const [selectedCard, setSelectedCard] = useState<CardframePaymentMethodMessage | null>(null);

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

    // A manual-card session is one transaction. Freeze its entity and amount for
    // this open cycle so Finance refreshes cannot replace it while Pay is in flight.
    useEffect(() => {
        const request = sessionRequestRef.current;
        if (!open) {
            flowIdRef.current += 1;
            cancelWaits();
            dispatch({ type: 'RESET', force: true });
            receiptDispatch({ type: 'RESET', email: request.contactEmail || '' });
            setDisplayAmount(request.amount ?? null);
            setSelectedCard(null);
            receiptSendingRef.current = false;
            return;
        }

        const flowId = ++flowIdRef.current;
        let cancelled = false;
        dispatch({ type: 'RESET' });
        receiptDispatch({ type: 'RESET', email: request.contactEmail || '' });
        setDisplayAmount(request.amount ?? null);
        setSelectedCard(null);
        // Freeze the pre-charge Due for success copy. Parent polling will soon pass the
        // post-charge balance; reading that live would subtract this payment twice.
        initialBalanceRef.current = request.balanceBefore;
        submitLockRef.current = false;
        receiptSendingRef.current = false;
        reconcileRunningRef.current = false;
        confirmedSessionRef.current = null;

        (async () => {
            try {
                const session = request.jobId != null
                    ? await jobStripeApi.manualCardSession(request.jobId, request.amount)
                    : await invoiceStripeApi.manualCardSession(request.invoiceId!, request.amount);
                if (cancelled || flowId !== flowIdRef.current) return;
                sessionRef.current = session;
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
            popupHandleRef.current?.cancel();
            popupHandleRef.current = null;
            sessionRef.current = null;
            setSelectedCard(null);
            submitLockRef.current = false;
            receiptSendingRef.current = false;
            reconcileRunningRef.current = false;
        };
    }, [open, cancelWaits]);

    // Contact hydration can finish after the panel opens. Adopt that prefill only
    // until the technician edits the field; never recreate the PaymentIntent for it.
    useEffect(() => {
        if (open) receiptDispatch({ type: 'PREFILL', email: contactEmail || '' });
    }, [open, contactEmail]);

    const enterSuccess = useCallback((result: ManualCardSessionResult, sessionId: number) => {
        const committed = commitManualCardSuccess(
            result,
            sessionId,
            confirmedSessionRef,
            succeeded => dispatch({ type: 'SUCCEEDED', result: succeeded }),
        );
        if (!committed) return;
        submitLockRef.current = true;
        const flowId = flowIdRef.current;
        void settleFinanceSync(result, onPaymentConfirmed).then(sync => {
            if (flowId === flowIdRef.current) dispatch({ type: 'FINANCE_SYNCED', sync });
        });
    }, [onPaymentConfirmed]);

    const reconcile = useCallback(async (
        popupResult: CardframeResultMessage = {
            kind: 'cardframe:result',
            status: 'failed',
        },
    ) => {
        const session = sessionRef.current;
        if (!session || reconcileRunningRef.current) return;
        reconcileRunningRef.current = true;
        submitLockRef.current = true;
        dispatch({ type: 'NETWORK_CHECKING' });
        const flowId = flowIdRef.current;
        await handleCardEntryPopupResult({
            popupResult,
            sessionId: session.session_id,
            succeededFallback: {
                amount: session.amount,
                brand: selectedCard?.brand ?? null,
                last4: selectedCard?.last4 ?? null,
            },
            getResult: stripePaymentsApi.getManualCardSessionResult,
            wait,
            isCancelled: () => flowId !== flowIdRef.current,
            onSucceeded: result => enterSuccess(result, session.session_id),
            onDeclined: message => {
                submitLockRef.current = false;
                setSelectedCard(null);
                dispatch({ type: 'DECLINED', message });
            },
            onUnresolved: () => dispatch({ type: 'NETWORK_UNRESOLVED' }),
        });
        if (flowId !== flowIdRef.current) return;
        reconcileRunningRef.current = false;
    }, [enterSuccess, selectedCard, wait]);

    const collectCard = useCallback(() => {
        const session = sessionRef.current;
        if (!session || submitLockRef.current) return;

        submitLockRef.current = true;
        dispatch({ type: 'COLLECT' });
        try {
            const handle = openManualCardEntryPopup(session, onCopyLinkFallback);
            if (!handle) {
                submitLockRef.current = false;
                dispatch({
                    type: 'INITIALIZATION_FAILED',
                    message: 'Allow pop-ups to enter card details, or copy a payment link instead.',
                });
                return;
            }
            popupHandleRef.current = handle;
            const flowId = flowIdRef.current;
            void handle.result.then(popupResult => {
                if (flowId !== flowIdRef.current) return;
                popupHandleRef.current = null;
                submitLockRef.current = false;
                if (popupResult.kind === 'cardframe:payment_method') {
                    setSelectedCard(popupResult);
                    dispatch({ type: 'CARD_SELECTED' });
                    return;
                }
                if (popupResult.status === 'canceled') {
                    dispatch({ type: 'POPUP_CANCELED' });
                    return;
                }
                dispatch({
                    type: 'INITIALIZATION_FAILED',
                    message: popupResult.message || 'Could not collect the card. Try again.',
                });
            });
        } catch (error: any) {
            submitLockRef.current = false;
            dispatch({
                type: 'INITIALIZATION_FAILED',
                message: String(error?.message || 'Could not open secure card entry'),
            });
        }
    }, [onCopyLinkFallback]);

    const pay = useCallback(async () => {
        const session = sessionRef.current;
        const card = selectedCard;
        if (!session || !card || submitLockRef.current) return;

        submitLockRef.current = true;
        dispatch({ type: 'CHARGE' });
        const flowId = flowIdRef.current;
        try {
            const outcome = await runManualCardCharge({
                session,
                paymentMethodId: card.pmId,
                confirmSession: stripePaymentsApi.confirmManualCardSession,
                finalizeSession: stripePaymentsApi.finalizeManualCardSession,
                openAuthentication: clientSecret => {
                    const handle = openManualCardAuthenticationPopup(
                        session,
                        clientSecret,
                        onCopyLinkFallback,
                    );
                    popupHandleRef.current = handle;
                    return handle;
                },
                onAuthenticationStarted: () => dispatch({ type: 'AUTHENTICATE' }),
            });
            if (flowId !== flowIdRef.current) return;
            popupHandleRef.current = null;
            if (outcome.status === 'succeeded') {
                enterSuccess({
                    status: 'succeeded',
                    amount: session.amount,
                    brand: card.brand,
                    last4: card.last4,
                }, session.session_id);
                return;
            }

            submitLockRef.current = false;
            if (outcome.status === 'canceled') {
                dispatch({ type: 'POPUP_CANCELED' });
                return;
            }
            if (outcome.status === 'popup_blocked') {
                dispatch({
                    type: 'INITIALIZATION_FAILED',
                    message: 'Allow pop-ups to verify the card, or copy a payment link instead.',
                });
                return;
            }
            setSelectedCard(null);
            dispatch({
                type: 'DECLINED',
                message: outcome.message || 'The card could not be charged.',
            });
        } catch (error: any) {
            if (flowId !== flowIdRef.current) return;
            popupHandleRef.current = null;
            await reconcile({
                kind: 'cardframe:result',
                status: 'failed',
                message: String(error?.message || 'The card could not be charged.'),
            });
        }
    }, [enterSuccess, onCopyLinkFallback, reconcile, selectedCard]);

    const sendReceipt = useCallback(async () => {
        const sessionId = sessionRef.current?.session_id;
        if (sessionId == null || receiptSendingRef.current || receiptState.phase === 'sent') return;
        const validationError = validateReceiptEmail(receiptState.email);
        if (validationError) {
            receiptDispatch({ type: 'ERROR', message: validationError });
            return;
        }

        const email = receiptState.email.trim().toLowerCase();
        const flowId = flowIdRef.current;
        receiptSendingRef.current = true;
        receiptDispatch({ type: 'SEND' });
        try {
            const result = await stripePaymentsApi.sendManualCardReceipt(sessionId, email);
            if (!result.sent) throw new Error('Receipt was not sent');
            if (flowId === flowIdRef.current) receiptDispatch({ type: 'SENT', email });
        } catch {
            if (flowId === flowIdRef.current) {
                receiptDispatch({ type: 'ERROR', message: 'We couldn’t send the receipt. Try again.' });
            }
        } finally {
            if (flowId === flowIdRef.current) receiptSendingRef.current = false;
        }
    }, [receiptState.email, receiptState.phase]);

    const amountText = formatSignedCurrency(displayAmount ?? 0);
    const cardLabel = state.result?.brand && state.result.last4
        ? `${state.result.brand.charAt(0).toUpperCase()}${state.result.brand.slice(1)} •••• ${state.result.last4}`
        : null;
    const selectedBrand = selectedCard
        ? `${selectedCard.brand.charAt(0).toUpperCase()}${selectedCard.brand.slice(1)}`
        : null;
    const contextLabel = jobId != null ? `Job ${jobId}` : 'Invoice';
    const receiptLocked = receiptState.phase === 'sending' || receiptState.phase === 'sent';
    const showContactSaveCaption = shouldShowReceiptContactSaveCaption(
        hasContact,
        contactEmail,
        receiptState.phase,
    );

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
                                        <Loader2 className="size-4 animate-spin" /> Preparing payment…
                                    </div>
                                )}

                                {state.phase === 'idle' && state.paymentError && (
                                    <p className="text-sm text-[var(--blanc-danger)]" role="alert">{state.paymentError}</p>
                                )}

                                {state.phase !== 'loading' && state.phase !== 'network' && (
                                    <div className="space-y-3.5">
                                        <p className="blanc-eyebrow">Payment card</p>
                                        {selectedCard ? (
                                            <div className="flex items-center gap-3 rounded-2xl bg-[var(--blanc-field)] px-4 py-3">
                                                <span className="rounded-full bg-[var(--blanc-accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--blanc-accent)]">
                                                    {selectedBrand}
                                                </span>
                                                <span className="min-w-0 flex-1 text-sm font-medium text-[var(--blanc-ink-1)]">
                                                    •••• {selectedCard.last4}
                                                </span>
                                                <button
                                                    type="button"
                                                    className="text-sm font-medium text-[var(--blanc-accent)] disabled:opacity-50"
                                                    onClick={() => void collectCard()}
                                                    disabled={state.phase !== 'idle' && state.phase !== 'declined'}
                                                >
                                                    Change
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                className="flex w-full items-center gap-3 rounded-2xl bg-[var(--blanc-field)] px-4 py-3 text-left text-sm font-medium text-[var(--blanc-ink-1)] disabled:opacity-50"
                                                onClick={() => void collectCard()}
                                                disabled={state.phase !== 'idle' && state.phase !== 'declined'}
                                            >
                                                <span className="flex size-8 items-center justify-center rounded-full bg-[var(--blanc-accent-soft)] text-[var(--blanc-accent)]">
                                                    <Plus className="size-4" aria-hidden="true" />
                                                </span>
                                                Add card
                                            </button>
                                        )}
                                    </div>
                                )}

                                {state.phase === 'collecting' && (
                                    <div className="flex items-center gap-2 rounded-2xl bg-[var(--blanc-field)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]" role="status">
                                        <Loader2 className="size-4 animate-spin" />
                                        Enter the card in the secure pop-up, then return here to pay.
                                    </div>
                                )}

                                {state.phase === 'charging' && (
                                    <div className="flex items-center gap-2 rounded-2xl bg-[var(--blanc-field)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]" role="status">
                                        <Loader2 className="size-4 animate-spin" />
                                        Charging {amountText}…
                                    </div>
                                )}

                                {state.phase === 'authenticating' && (
                                    <div className="flex items-center gap-2 rounded-2xl bg-[var(--blanc-field)] px-4 py-3 text-sm text-[var(--blanc-ink-2)]" role="status">
                                        <Loader2 className="size-4 animate-spin" />
                                        Complete the bank verification in the secure pop-up.
                                    </div>
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
                            <ManualCardSuccessView
                                result={state.result!}
                                cardLabel={cardLabel}
                                receiptState={receiptState}
                                receiptLocked={receiptLocked}
                                showContactSaveCaption={showContactSaveCaption}
                                onReceiptEmailChange={email => receiptDispatch({ type: 'EDIT', email })}
                                onSendReceipt={() => void sendReceipt()}
                            />
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
                                disabled={
                                    state.phase === 'collecting'
                                    || state.phase === 'charging'
                                    || state.phase === 'authenticating'
                                    || state.phase === 'network'
                                }
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
                                    onClick={() => void pay()}
                                    disabled={
                                        state.phase === 'loading'
                                        || state.phase === 'collecting'
                                        || state.phase === 'charging'
                                        || state.phase === 'authenticating'
                                        || !sessionRef.current
                                        || !selectedCard
                                    }
                                >
                                    {(state.phase === 'charging' || state.phase === 'authenticating')
                                        && <Loader2 className="mr-2 size-4 animate-spin" />}
                                    {state.phase === 'charging'
                                        ? `Paying ${amountText}…`
                                        : state.phase === 'authenticating'
                                            ? 'Verifying card…'
                                            : `Pay ${amountText}`}
                                </Button>
                            )}
                        </>
                    )}
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

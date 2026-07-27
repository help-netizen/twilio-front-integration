import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createCardEntryController, INITIAL_CARD_ENTRY_STATE, type CardEntryController } from './controller';
import { resolveExpectedAppOrigin } from './protocol';
import { mountStripeCard } from './stripeCard';
import { loadStripe } from '../utils/loadStripe';
import './card-entry.css';

function formatAmount(amount: number | null): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
    }).format(amount ?? 0);
}

export function CardEntryPage() {
    const mountRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<CardEntryController | null>(null);
    const [state, setState] = useState(INITIAL_CARD_ENTRY_STATE);

    useEffect(() => {
        const controller = createCardEntryController({
            opener: window.opener,
            expectedAppOrigin: resolveExpectedAppOrigin(
                document.referrer,
                window.location.origin,
                import.meta.env.VITE_CARD_ENTRY_ORIGIN,
            ),
            addMessageListener: listener => window.addEventListener('message', listener),
            removeMessageListener: listener => window.removeEventListener('message', listener),
            loadStripe,
            mountCard: mountStripeCard,
            getMountNode: () => mountRef.current,
            closeWindow: () => window.close(),
            onStateChange: setState,
        });
        controllerRef.current = controller;
        controller.start();
        return () => {
            controllerRef.current = null;
            controller.dispose();
        };
    }, []);

    const busy = state.phase === 'waiting' || state.phase === 'loading' || state.phase === 'submitting';
    const amountText = formatAmount(state.amount);

    return (
        <main className="card-entry-page">
            <section className="card-entry-shell" aria-labelledby="card-entry-title">
                <p className="card-entry-eyebrow">Secure payment</p>
                <h1 id="card-entry-title" className="card-entry-title">Enter card details</h1>
                <p className="card-entry-amount">
                    {state.amount == null ? 'Waiting for payment details…' : `Amount ${amountText}`}
                </p>

                <p className="card-entry-security">
                    Card details are encrypted and sent directly to Stripe. Albusto never sees the card number.
                </p>

                <div
                    ref={mountRef}
                    className="card-entry-field"
                    data-focused={state.cardFocused}
                    data-error={Boolean(state.message)}
                    data-disabled={busy}
                    aria-label="Card number, MM/YY, CVC, ZIP"
                />
                <p className="card-entry-caption">Secure card fields by Stripe</p>
                <p
                    className="card-entry-status"
                    data-error={Boolean(state.message)}
                    role={state.message ? 'alert' : 'status'}
                    aria-live="polite"
                >
                    {state.message
                        || (state.phase === 'loading'
                            ? 'Preparing secure card fields…'
                            : state.phase === 'submitting'
                                ? 'Confirming payment…'
                                : '')}
                </p>

                <div className="card-entry-actions">
                    <button
                        type="button"
                        className="card-entry-button card-entry-button-secondary"
                        onClick={() => controllerRef.current?.cancel()}
                        disabled={state.phase === 'submitting'}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="card-entry-button card-entry-button-primary"
                        onClick={() => void controllerRef.current?.confirm()}
                        disabled={state.phase !== 'idle' || !state.cardComplete || Boolean(state.message)}
                    >
                        {state.phase === 'submitting' ? `Paying ${amountText}…` : `Pay ${amountText}`}
                    </button>
                </div>
            </section>
        </main>
    );
}

createRoot(document.getElementById('card-entry-root')!).render(<CardEntryPage />);

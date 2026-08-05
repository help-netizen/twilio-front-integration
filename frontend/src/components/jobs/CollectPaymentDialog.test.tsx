import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualCardSessionResult } from '../../services/stripePaymentsApi';
import dialogSource from './CollectPaymentDialog.tsx?raw';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiClient', () => ({ authedFetch }));

vi.mock('../ui/button', () => ({ Button: () => null }));
vi.mock('../ui/dialog', () => ({
    Dialog: () => null,
    DialogContent: () => null,
    DialogDescription: () => null,
    DialogPanelHeader: () => null,
    DialogBody: () => null,
    DialogPanelFooter: () => null,
    DialogTitle: () => null,
}));
vi.mock('../ui/floating-field', () => ({ FloatingField: () => null }));
vi.mock('../invoices/ManualCardDialog', () => ({ default: () => null }));
import {
    amountAfterCollectionRefresh,
    createManualCardCollectionCallbacks,
    SavedCardChargeButton,
    savedCardChargeLabel,
    savedCardConfirmationCopy,
} from './CollectPaymentDialog';
import { jobStripeApi } from '../../services/stripePaymentsApi';

const PAYMENT: ManualCardSessionResult = {
    status: 'succeeded',
    amount: 95,
    brand: 'visa',
    last4: '4242',
};

const SAVED_CARD = {
    id: 41,
    brand: 'visa',
    last4: '4242',
    exp_month: 12,
    exp_year: 2030,
};

beforeEach(() => {
    authedFetch.mockReset().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn(async () => ({ ok: true, data: { status: 'succeeded', amount: 1 } })),
    });
});

describe('CollectPaymentDialog manual-card wiring', () => {
    it('renders the saved-card action without TTL copy', () => {
        const label = savedCardChargeLabel({ brand: 'visa', last4: '4242' }, 123.45);
        expect(label).toBe('Charge Visa •••• 4242 — $123.45');
        expect(label.toLowerCase()).not.toContain('expire');
    });

    it('carries the entered $1.00 through the saved-card request while preserving displayed due', async () => {
        await jobStripeApi.chargeSavedPaymentMethod(7, {
            savedCardId: 41,
            amount: 1,
            expectedDue: 280,
            requestKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });

        const request = authedFetch.mock.calls[0][1];
        expect(JSON.parse(request.body)).toEqual({
            saved_card_id: 41,
            amount: 1,
            expected_due: 280,
            request_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
    });

    it.each(['', '0.49'])(
        'disables the saved-card action for invalid amount %j and cannot open confirmation',
        rawAmount => {
            const onCharge = vi.fn();
            const button = SavedCardChargeButton({
                card: SAVED_CARD,
                amount: rawAmount,
                due: 280,
                disabled: false,
                onCharge,
            }) as ReactElement<{ disabled: boolean; onClick: () => void }>;

            expect(button.props.disabled).toBe(true);
            button.props.onClick();
            expect(onCharge).not.toHaveBeenCalled();
        },
    );

    it('shows the live entered amount and confirmation copy, never the full due', () => {
        const onCharge = vi.fn();
        const button = SavedCardChargeButton({
            card: SAVED_CARD,
            amount: '1.00',
            due: 280,
            disabled: false,
            onCharge,
        }) as ReactElement<{ disabled: boolean; onClick: () => void }>;

        expect(button.props.disabled).toBe(false);
        expect(savedCardChargeLabel(SAVED_CARD, 1)).toBe('Charge Visa •••• 4242 — $1.00');
        expect(savedCardConfirmationCopy(SAVED_CARD, 1)).toBe('Charge $1.00 to Visa •••• 4242?');
        button.props.onClick();
        expect(onCharge).toHaveBeenCalledWith(SAVED_CARD, 1);
    });

    it('renders the amount input before the saved-card action', () => {
        expect(dialogSource.indexOf('{/* Amount step */}')).toBeGreaterThan(-1);
        expect(dialogSource.indexOf('<SavedCardChargeButton')).toBeGreaterThan(-1);
        expect(dialogSource.indexOf('{/* Amount step */}'))
            .toBeLessThan(dialogSource.indexOf('<SavedCardChargeButton'));
    });
    it('preserves the charged amount when Finance refreshes the parent balance', () => {
        expect(amountAfterCollectionRefresh('1.00', 0, true)).toBe('1.00');
        expect(amountAfterCollectionRefresh('1.00', 0, false)).toBe('');
    });

    it('starts Finance revalidation on confirmation without closing either panel', async () => {
        const setManualCardOpen = vi.fn();
        const setCollectionOpen = vi.fn();
        const onPaymentConfirmed = vi.fn(async () => true);
        const onDone = vi.fn();
        const callbacks = createManualCardCollectionCallbacks({
            setManualCardOpen,
            setCollectionOpen,
            onPaymentConfirmed,
            onDone,
        });

        await expect(callbacks.onPaymentConfirmed(PAYMENT)).resolves.toBe(true);
        expect(onPaymentConfirmed).toHaveBeenCalledWith(PAYMENT);
        expect(setManualCardOpen).not.toHaveBeenCalled();
        expect(setCollectionOpen).not.toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
    });

    it('closes the shared card panel and owning chooser only on Done', () => {
        const setManualCardOpen = vi.fn();
        const setCollectionOpen = vi.fn();
        const onDone = vi.fn();
        const callbacks = createManualCardCollectionCallbacks({
            setManualCardOpen,
            setCollectionOpen,
            onDone,
        });

        callbacks.onDone();

        expect(setManualCardOpen).toHaveBeenCalledWith(false);
        expect(setCollectionOpen).toHaveBeenCalledWith(false);
        expect(onDone).toHaveBeenCalledOnce();
    });
});

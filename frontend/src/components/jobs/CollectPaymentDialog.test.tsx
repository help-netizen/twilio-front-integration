import { describe, expect, it, vi } from 'vitest';
import type { ManualCardSessionResult } from '../../services/stripePaymentsApi';

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
    savedCardChargeLabel,
} from './CollectPaymentDialog';

const PAYMENT: ManualCardSessionResult = {
    status: 'succeeded',
    amount: 95,
    brand: 'visa',
    last4: '4242',
};

describe('CollectPaymentDialog manual-card wiring', () => {
    it('renders the saved-card action without TTL copy', () => {
        const label = savedCardChargeLabel({ brand: 'visa', last4: '4242' }, 123.45);
        expect(label).toBe('Charge Visa •••• 4242 — $123.45');
        expect(label.toLowerCase()).not.toContain('expire');
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

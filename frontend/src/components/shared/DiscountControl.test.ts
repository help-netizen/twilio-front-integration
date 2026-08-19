import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiscountControl, discountAfterKindSwitch } from './DiscountControl';
import controlRaw from './DiscountControl.tsx?raw';
import invoiceCardRaw from '../invoices/InvoiceDetailPanel.tsx?raw';
import invoiceFormRaw from '../invoices/InvoiceEditorDialog.tsx?raw';
import estimateCardRaw from '../estimates/EstimateDetailPanel.tsx?raw';
import estimateFormRaw from '../estimates/EstimateEditorDialog.tsx?raw';

/**
 * OB-69 — a discount is entered the same way everywhere.
 *
 * The task existed because it wasn't: estimates could be discounted by a percentage,
 * invoices only by an amount, and the invoice's create form had a % toggle that was
 * thrown away on save (the column didn't exist until migration 287). Four hand-copied
 * controls is how that gap survived, so the fix is one control — and these keep it one.
 */
describe('the discount is entered the same way on all four surfaces', () => {
    const surfaces: Array<[string, string]> = [
        ['invoice card', invoiceCardRaw],
        ['invoice form', invoiceFormRaw],
        ['estimate card', estimateCardRaw],
        ['estimate form', estimateFormRaw],
    ];

    it.each(surfaces)('%s renders the shared control', (_name, source) => {
        expect(source).toContain('<DiscountControl');
        expect(source).toContain("from '../shared/DiscountControl'");
    });

    it.each(surfaces)('%s keeps no toggle of its own', (_name, source) => {
        // A second $/% pair anywhere is the beginning of the next drift.
        expect(source).not.toContain('>$</button>');
        expect(source).not.toContain('>%</button>');
    });

    it('sends the kind, not just the figure it worked out to', () => {
        // Both create forms used to post `discount_amount` alone, which flattened a
        // percentage into dollars the moment it was saved: reopening showed $570 off,
        // never 30%, and editing the items no longer moved the discount with them.
        expect(invoiceFormRaw).toContain('discount_type: discountType,');
        expect(invoiceFormRaw).toContain('discount_value:');
        expect(estimateFormRaw).toContain('discount_type: discountType,');
        expect(estimateFormRaw).toContain('discount_value:');
    });

    it('offers the toggle by name to anyone who cannot see it', () => {
        expect(controlRaw).toContain('aria-label="Discount as an amount"');
        expect(controlRaw).toContain('aria-label="Discount as a percentage"');
        expect(controlRaw).toContain('aria-pressed');
    });
});

describe('switching $ ⇄ %', () => {
    it('drops the number rather than reinterpreting it', () => {
        // $30 is not 30%. On a $2,000 invoice, carrying the figure across would take
        // another $570 off without anyone touching the discount.
        expect(discountAfterKindSwitch('fixed', 'percentage')).toEqual({ kind: 'percentage', value: '' });
        expect(discountAfterKindSwitch('percentage', 'fixed')).toEqual({ kind: 'fixed', value: '' });
    });

    it('is a no-op when the pressed side is already on', () => {
        // Otherwise pressing $ on a $30 discount would quietly erase the 30.
        expect(discountAfterKindSwitch('fixed', 'fixed')).toBeNull();
        expect(discountAfterKindSwitch('percentage', 'percentage')).toBeNull();
    });

    it('starts a discount that has no kind yet', () => {
        expect(discountAfterKindSwitch(null, 'percentage')).toEqual({ kind: 'percentage', value: '' });
    });
});

/**
 * The two places it lives are different sizes, and each has to keep the size of the
 * field it sits next to — a card's totals line (h-8, beside Tax rate) and an editor's
 * totals block (the 50px filled field the rest of that form uses). Sharing a component
 * is only a win if it did not quietly resize four screens on the way in.
 */
describe('it keeps the geometry of the place it is in', () => {
    const render = (size: 'compact' | 'field', kind: 'fixed' | 'percentage') =>
        renderToStaticMarkup(createElement(DiscountControl, {
            kind, value: '30', size,
            onKindChange: () => {}, onValueChange: () => {}, onRemove: () => {},
        }));

    it('stays on the card totals line at compact', () => {
        expect(render('compact', 'fixed')).toContain('h-8 w-24');
        expect(render('compact', 'percentage')).toContain('h-8 w-24');
    });

    it('takes the editor field size where the form is fields', () => {
        expect(render('field', 'fixed')).toContain('h-[50px]');
        expect(render('field', 'fixed')).toContain('w-28');
        expect(render('field', 'percentage')).toContain('w-28');
    });

    it('names the field for whichever kind is showing', () => {
        // The toggle says $ or %, and the floating label repeats it in words — the
        // form's own convention, and the only label a screen reader gets on the input.
        expect(render('field', 'fixed')).toContain('Amount');
        expect(render('field', 'percentage')).toContain('Percent');
    });
});

describe('the pressed side stays readable', () => {
    it('carries its colours inline, where the stylesheet cannot take them back', () => {
        // design-system.css loads after the Tailwind utilities, so `.blanc-l2` wins the
        // colour on the same element. With `text-white` the active tab rendered ink on
        // ink — a black pill with an invisible $ — which is how the estimate card looked
        // in production. Verified in the browser: rgb(255,255,255) on rgb(25,25,25).
        const markup = renderToStaticMarkup(createElement(DiscountControl, {
            kind: 'fixed', value: '30',
            onKindChange: () => {}, onValueChange: () => {}, onRemove: () => {},
        }));
        expect(markup).toContain('color:#FFFFFF');
        expect(markup).not.toContain('text-white');
    });
});

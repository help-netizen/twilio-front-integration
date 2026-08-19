import { MoneyInput } from '../ui/MoneyInput';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { Trash2 } from 'lucide-react';

export type DiscountKind = 'fixed' | 'percentage' | null;

/**
 * What the discount becomes when the $/% toggle is pressed — `null` when nothing
 * changes (the pressed side was already on).
 *
 * The number is dropped, deliberately: a $30 discount is not a 30% one, and carrying
 * the figure across would silently change what the customer is charged — on a $2,000
 * invoice, by $570. Exported so the rule can be tested and so all four surfaces get
 * the same answer instead of each remembering to clear.
 */
export function discountAfterKindSwitch(
    current: DiscountKind,
    next: Exclude<DiscountKind, null>,
): { kind: Exclude<DiscountKind, null>; value: string } | null {
    return next === current ? null : { kind: next, value: '' };
}

/**
 * The discount control — ONE component for estimates and invoices, create and edit.
 *
 * OB-69: the invoice's EDIT surface offered only an amount while its CREATE form had a
 * $/% toggle, because invoices used to store `discount_amount` alone. Migration 287 gave
 * them `discount_type` + `discount_value` (the shape estimates already had), so the four
 * surfaces can finally share one control instead of four hand-copied ones — which is what
 * let them drift apart in the first place.
 *
 * The parent owns the state and decides what a change means (persist on blur, or hold it
 * until Save); this renders the toggle, the right input for the kind, and the remove.
 *
 * Two densities, because the control lives in two kinds of place: `compact` for the
 * totals line of a detail card, `field` for an editor's totals block, where it sits
 * directly above Tax rate and has to be the same size as it.
 */
export function DiscountControl({
    kind, value, onKindChange, onValueChange, onCommit, onRemove,
    disabled = false, showLabel = true, size = 'compact', invalid = false, describedBy,
}: {
    kind: DiscountKind;
    value: string;
    /** The new kind AND the value that goes with it — see discountAfterKindSwitch. */
    onKindChange: (kind: DiscountKind, value: string) => void;
    onValueChange: (value: string) => void;
    /** Called when the edit is finished (blur) — the parent persists or defers. */
    onCommit?: () => void;
    onRemove: () => void;
    disabled?: boolean;
    /** Off where the row above already names it (an editor's totals line). */
    showLabel?: boolean;
    size?: 'compact' | 'field';
    invalid?: boolean;
    describedBy?: string;
}) {
    // The colours are inline on purpose. design-system.css loads AFTER the Tailwind
    // utilities, so `.blanc-l2` wins the colour on the same element: `text-white` on
    // the active tab came out ink-on-ink and the $ was invisible on a black pill —
    // which is what this control looked like on the estimate card until now.
    const tab = 'px-2.5 py-0.5 rounded-md blanc-l2 transition-colors hover:bg-[rgba(25,25,25,0.04)]';
    const tabStyle = (active: boolean) => (active
        ? { background: 'var(--blanc-ink-1)', color: '#FFFFFF' }
        : { color: 'var(--blanc-ink-2)' });

    const switchTo = (next: Exclude<DiscountKind, null>) => {
        const changed = discountAfterKindSwitch(kind, next);
        if (changed) onKindChange(changed.kind, changed.value);
    };

    const percentInput = size === 'field' ? (
        <FloatingField
            label="Percent"
            value={value}
            inputMode="decimal"
            disabled={disabled}
            containerClassName="w-28"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={event => onValueChange(event.target.value.replace(/[^0-9.]/g, ''))}
            onBlur={onCommit}
        />
    ) : (
        <Input
            type="text"
            inputMode="decimal"
            value={value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={event => onValueChange(event.target.value.replace(/[^0-9.]/g, ''))}
            onBlur={onCommit}
            className="h-8 w-24 text-right tabular-nums"
        />
    );

    const amountInput = size === 'field' ? (
        <FloatingLabel label="Amount" filled className="w-28">
            <MoneyInput
                value={value}
                disabled={disabled}
                onValueChange={onValueChange}
                onBlur={onCommit}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                className="h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent px-3 text-right text-sm tabular-nums outline-none focus:border-[var(--blanc-line-strong)]"
            />
        </FloatingLabel>
    ) : (
        <MoneyInput
            value={value}
            disabled={disabled}
            onValueChange={onValueChange}
            onBlur={onCommit}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className="h-8 w-24 rounded-[10px] border-[1.5px] border-transparent bg-[var(--blanc-field,#F0F0F0)] px-3 text-right blanc-l2 tabular-nums outline-none transition-colors focus-visible:border-[var(--blanc-ink-2)] disabled:opacity-50"
        />
    );

    return (
        <div className="flex flex-wrap items-center gap-2 blanc-l2">
            {showLabel && <span className="text-[var(--blanc-ink-2)]">Discount</span>}
            <div
                className="inline-flex shrink-0 rounded-[10px] border border-[var(--blanc-line)] p-0.5"
                style={{ background: 'var(--blanc-panel-surface, #fffdf9)' }}
            >
                <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={kind === 'fixed'}
                    aria-label="Discount as an amount"
                    onClick={() => switchTo('fixed')}
                    className={tab}
                    style={tabStyle(kind === 'fixed')}
                >$</button>
                <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={kind === 'percentage'}
                    aria-label="Discount as a percentage"
                    onClick={() => switchTo('percentage')}
                    className={tab}
                    style={tabStyle(kind === 'percentage')}
                >%</button>
            </div>
            {kind === 'percentage' ? percentInput : amountInput}
            <Button
                type="button"
                variant="ghost"
                size={size === 'field' ? 'icon' : 'sm'}
                className={size === 'field' ? 'size-10 shrink-0' : 'size-8 shrink-0 p-0'}
                disabled={disabled}
                onClick={onRemove}
                title="Remove discount"
                aria-label="Remove discount"
            >
                <Trash2 className="size-4" />
            </Button>
        </div>
    );
}

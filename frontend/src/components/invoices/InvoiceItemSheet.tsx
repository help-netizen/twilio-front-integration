import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { MoneyInput } from '../ui/MoneyInput';
import { ItemPresetSearchCombobox } from '../estimates/ItemPresetSearchCombobox';
import type { EstimateItemPreset } from '../../services/estimateItemPresetsApi';

export interface InvoiceItemDraft {
    name: string;
    description: string;
    quantity: string;
    unit_price: string;
    taxable: boolean;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isEdit?: boolean;
    initial: InvoiceItemDraft;
    onSave: (draft: InvoiceItemDraft) => void | Promise<void>;
    onRemove?: () => void | Promise<void>;
    onPickPreset?: (preset: EstimateItemPreset) => void | Promise<void>;
    onPickGroup?: (groupId: number) => void | Promise<void>;
    onCreateFromSearch?: (name: string) => void;
    catalogCreateAllowed?: boolean;
}

const emptyDraft = (): InvoiceItemDraft => ({
    name: '',
    description: '',
    quantity: '1',
    unit_price: '0',
    taxable: true,
});

export function InvoiceItemSheet({
    open,
    onOpenChange,
    isEdit = false,
    initial,
    onSave,
    onRemove,
    onPickPreset,
    onPickGroup,
    onCreateFromSearch,
    catalogCreateAllowed = false,
}: Props) {
    const [draft, setDraft] = useState<InvoiceItemDraft>(initial ?? emptyDraft());
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) setDraft(initial ?? emptyDraft());
    }, [initial, open]);

    const canSave = draft.name.trim().length > 0
        && Number(draft.quantity) > 0
        && Number(draft.unit_price) >= 0;

    const save = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        try {
            await onSave({ ...draft, name: draft.name.trim() });
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!onRemove || saving) return;
        setSaving(true);
        try {
            await onRemove();
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    };

    const pickPreset = async (preset: EstimateItemPreset) => {
        if (!onPickPreset || saving) return;
        setSaving(true);
        try {
            await onPickPreset(preset);
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    };

    const pickGroup = async (groupId: number) => {
        if (!onPickGroup || saving) return;
        setSaving(true);
        try {
            await onPickGroup(groupId);
            onOpenChange(false);
        } finally {
            setSaving(false);
        }
    };

    const createFromSearch = (name: string) => {
        setDraft(previous => ({ ...previous, name }));
        onCreateFromSearch?.(name);
    };

    const buttons = (
        <div className="space-y-2.5">
            <Button
                type="button"
                size="action" className="h-[52px] w-full rounded-[15px] text-[15px]"
                onClick={save}
                disabled={!canSave || saving}
                data-testid="invoice-item-save"
            >
                {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {isEdit ? 'Save item' : 'Add item'}
            </Button>
            <Button
                type="button"
                variant="outline"
                size="action" className="h-[46px] w-full rounded-[13px] text-[15px]"
                onClick={() => onOpenChange(false)}
                disabled={saving}
            >
                Cancel
            </Button>
            {isEdit && onRemove ? (
                <Button
                    type="button"
                    variant="ghost"
                    className="h-10 w-full text-[13px] text-[var(--blanc-danger)] hover:text-[var(--blanc-danger)]"
                    onClick={remove}
                    disabled={saving}
                >
                    Remove item
                </Button>
            ) : null}
        </div>
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel" size="default" data-testid="invoice-item-sheet">
                <DialogPanelHeader className="max-md:hidden">
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                        style={{ fontFamily: 'var(--blanc-font-heading)' }}
                    >
                        {isEdit ? 'Edit item' : 'Add item'}
                    </DialogTitle>
                    <DialogDescription>
                        {isEdit ? 'Update this invoice item.' : 'Search your Price Book, or fill it in below.'}
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="px-[18px] pb-7 pt-9 md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px]">
                        <div className="mb-5 md:hidden">
                            <DialogTitle
                                className="text-[22px] font-semibold leading-tight text-[var(--blanc-ink-1)]"
                                style={{ fontFamily: 'var(--blanc-font-heading)' }}
                            >
                                {isEdit ? 'Edit item' : 'Add item'}
                            </DialogTitle>
                            <p className="mt-1.5 text-[13px] text-[var(--blanc-ink-3)]">
                                {isEdit ? 'Update this invoice item.' : 'Search your Price Book, or fill it in below.'}
                            </p>
                        </div>

                        <div className="space-y-3.5">
                            {!isEdit && onPickPreset ? (
                                <div data-testid="invoice-item-price-book">
                                    <ItemPresetSearchCombobox
                                        inlineOnMobile
                                        sheetField
                                        disabled={saving}
                                        onPickPreset={pickPreset}
                                        onPickGroup={onPickGroup ? pickGroup : undefined}
                                        onCreateNew={createFromSearch}
                                        catalogCreateAllowed={catalogCreateAllowed}
                                    />
                                </div>
                            ) : null}
                            <FloatingField
                                id="invoice-item-title"
                                label="Title"
                                value={draft.name}
                                onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))}
                                disabled={saving}
                            />
                            <FloatingField
                                id="invoice-item-description"
                                label="Description"
                                textarea
                                rows={3}
                                value={draft.description}
                                onChange={event => setDraft(previous => ({ ...previous, description: event.target.value }))}
                                disabled={saving}
                            />
                            <div className="grid grid-cols-2 gap-3.5">
                                <FloatingField
                                    id="invoice-item-quantity"
                                    label="Qty"
                                    inputMode="decimal"
                                    value={draft.quantity}
                                    onChange={event => setDraft(previous => ({
                                        ...previous,
                                        quantity: event.target.value.replace(/[^0-9.]/g, ''),
                                    }))}
                                    disabled={saving}
                                />
                                <FloatingLabel label="Unit price" htmlFor="invoice-item-unit-price" filled>
                                    <MoneyInput
                                        id="invoice-item-unit-price"
                                        value={draft.unit_price}
                                        onValueChange={unit_price => setDraft(previous => ({ ...previous, unit_price }))}
                                        disabled={saving}
                                        className="h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none focus:border-[var(--blanc-line-strong)]"
                                    />
                                </FloatingLabel>
                            </div>
                            <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 text-[14px] font-medium text-[var(--blanc-ink-1)]">
                                <span>Service is taxable</span>
                                <Checkbox
                                    checked={draft.taxable}
                                    onCheckedChange={checked => setDraft(previous => ({ ...previous, taxable: !!checked }))}
                                    disabled={saving}
                                    className="size-6"
                                />
                            </label>
                        </div>

                        <div className="mt-4 md:hidden">{buttons}</div>
                    </div>
                </DialogBody>

                <DialogPanelFooter className="max-md:hidden">
                    <div className="ml-auto w-full max-w-[360px]">{buttons}</div>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { Checkbox } from '../ui/checkbox';

export interface ItemDraft {
    name: string;
    description: string;
    quantity: string;
    unit_price: string;
    taxable: boolean;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** When set, dialog title shows "Edit" and Save button label changes. */
    isEdit?: boolean;
    initial: ItemDraft;
    onSave: (draft: ItemDraft) => void;
}

const empty = (): ItemDraft => ({ name: '', description: '', quantity: '1', unit_price: '0', taxable: false });

export function EstimateItemDialog({ open, onOpenChange, isEdit, initial, onSave }: Props) {
    const [draft, setDraft] = useState<ItemDraft>(initial ?? empty());

    useEffect(() => {
        if (open) setDraft(initial ?? empty());
    }, [open, initial]);

    const canSave = draft.name.trim().length > 0 && Number(draft.quantity) > 0 && Number(draft.unit_price) >= 0;

    const handleSave = () => {
        if (!canSave) return;
        onSave(draft);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel" className="z-[70]">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        {isEdit ? 'Edit item' : 'Add custom item'}
                    </DialogTitle>
                    <DialogDescription className="sr-only">Add or edit an estimate line item</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                  <div className="mx-auto w-full max-w-[740px] space-y-6">
                    <div className="space-y-3.5">
                        <FloatingField
                            id="eid-name"
                            label="Title"
                            value={draft.name}
                            onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                        />
                        <FloatingField
                            id="eid-description"
                            label="Description"
                            textarea
                            rows={4}
                            value={draft.description}
                            onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            <FloatingField
                                id="eid-quantity"
                                label="Qty"
                                inputMode="decimal"
                                value={draft.quantity}
                                onChange={e => setDraft(prev => ({ ...prev, quantity: e.target.value }))}
                            />
                            <FloatingField
                                id="eid-unit-price"
                                label="Unit price"
                                inputMode="decimal"
                                value={draft.unit_price}
                                onChange={e => setDraft(prev => ({ ...prev, unit_price: e.target.value }))}
                            />
                        </div>
                    </div>

                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--blanc-ink-1)' }}>
                        <Checkbox
                            checked={draft.taxable}
                            onCheckedChange={checked => setDraft(prev => ({ ...prev, taxable: !!checked }))}
                        />
                        Service is taxable
                    </label>
                  </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" onClick={handleSave} disabled={!canSave}>
                        {isEdit ? 'Save changes' : 'Add item'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
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
            <DialogContent className="max-w-lg z-[70]">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit item' : 'Add custom item'}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    <div>
                        <Label>Title <span className="text-red-600">*</span></Label>
                        <Input
                            value={draft.name}
                            onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                            autoFocus
                        />
                    </div>
                    <div>
                        <Label>Description</Label>
                        <Textarea
                            value={draft.description}
                            onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                            rows={4}
                            className="font-normal"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Label>Qty</Label>
                            <Input
                                type="number"
                                min="0.01"
                                step="any"
                                value={draft.quantity}
                                onChange={e => setDraft(prev => ({ ...prev, quantity: e.target.value }))}
                            />
                        </div>
                        <div>
                            <Label>Unit price <span className="text-red-600">*</span></Label>
                            <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={draft.unit_price}
                                onChange={e => setDraft(prev => ({ ...prev, unit_price: e.target.value }))}
                            />
                        </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                            checked={draft.taxable}
                            onCheckedChange={checked => setDraft(prev => ({ ...prev, taxable: !!checked }))}
                        />
                        Service is taxable
                    </label>
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" onClick={handleSave} disabled={!canSave}>
                        {isEdit ? 'Save changes' : 'Add item'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

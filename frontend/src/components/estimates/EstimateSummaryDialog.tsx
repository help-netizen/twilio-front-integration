import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initial: string;
    onSave: (text: string) => void;
}

export function EstimateSummaryDialog({ open, onOpenChange, initial, onSave }: Props) {
    const [draft, setDraft] = useState(initial ?? '');

    useEffect(() => {
        if (open) setDraft(initial ?? '');
    }, [open, initial]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl z-[70]">
                <DialogHeader><DialogTitle>Summary</DialogTitle></DialogHeader>
                <Textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    rows={10}
                    placeholder="Make, model, serial, failure issue, findings, needs, cause..."
                    className="font-normal"
                />
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" onClick={() => { onSave(draft); onOpenChange(false); }}>Save Summary</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

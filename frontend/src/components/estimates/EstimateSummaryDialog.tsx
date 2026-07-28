import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useIsMobile } from '../../hooks/useIsMobile';
import { FullScreenTextEditor } from '../shared/FullScreenTextEditor';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initial: string;
    onSave: (text: string) => void;
}

const SUMMARY_PLACEHOLDER = 'Make, model, serial, failure issue, findings, needs, cause…';

export function EstimateSummaryDialog({ open, onOpenChange, initial, onSave }: Props) {
    const isMobile = useIsMobile();
    const [draft, setDraft] = useState(initial ?? '');

    useEffect(() => {
        if (open) setDraft(initial ?? '');
    }, [open, initial]);

    // Mobile: the summary is often long — edit it in the full-screen editor (type B), not a
    // keyboard-covered dialog.
    if (isMobile) {
        return (
            <FullScreenTextEditor
                open={open}
                initialValue={initial ?? ''}
                onDone={text => { onSave(text); onOpenChange(false); }}
                onCancel={() => onOpenChange(false)}
                title="Summary"
                placeholder={SUMMARY_PLACEHOLDER}
            />
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader><DialogTitle>Summary</DialogTitle></DialogHeader>
                <Textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    rows={10}
                    placeholder={SUMMARY_PLACEHOLDER}
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

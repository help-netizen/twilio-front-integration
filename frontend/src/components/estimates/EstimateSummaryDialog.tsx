import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
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

    // Desktop: the right-side panel with a floating-label field (FORM-CANON), which
    // is what the editor's own copy of this used before the two were collapsed into
    // one. Keeping the better of the two rather than the older of the two.
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Summary
                    </DialogTitle>
                    <DialogDescription className="sr-only">Edit the estimate summary</DialogDescription>
                </DialogPanelHeader>
                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px]">
                        <FloatingField
                            textarea
                            rows={10}
                            id="estimate-summary"
                            label={SUMMARY_PLACEHOLDER}
                            value={draft}
                            onChange={event => setDraft(event.target.value)}
                        />
                    </div>
                </DialogBody>
                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" onClick={() => { onSave(draft); onOpenChange(false); }}>Save summary</Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

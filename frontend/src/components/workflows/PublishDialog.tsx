import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { usePublishDraft } from '../../hooks/useFsmEditor';

interface PublishDialogProps {
    machineKey: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPublished: () => void;
    /** Runs before the publish request — e.g. saves the working draft so Publish activates the
     *  latest edits. Throwing aborts the publish (nothing is published). */
    onBeforePublish?: () => Promise<void>;
}

export default function PublishDialog({
    machineKey,
    open,
    onOpenChange,
    onPublished,
    onBeforePublish,
}: PublishDialogProps) {
    const [changeNote, setChangeNote] = useState('');
    const [busy, setBusy] = useState(false);
    const publishMutation = usePublishDraft(machineKey);

    const canPublish = changeNote.trim().length > 0 && !busy;

    const handlePublish = async () => {
        setBusy(true);
        try {
            if (onBeforePublish) await onBeforePublish(); // save the working draft first
            await publishMutation.mutateAsync({ change_note: changeNote.trim() });
            toast.success('Workflow published');
            setChangeNote('');
            onPublished();
            onOpenChange(false);
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : 'Failed to publish workflow';
            toast.error(message);
        } finally {
            setBusy(false);
        }
    };

    const handleOpenChange = (next: boolean) => {
        if (!next) setChangeNote('');
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="md:max-w-md">
                <DialogHeader>
                    <DialogTitle>Publish Workflow</DialogTitle>
                    <DialogDescription>
                        This will make the current draft the active workflow version.
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-2 space-y-4">
                    <div>
                        <label
                            htmlFor="publish-change-note"
                            className="blanc-eyebrow mb-2 block"
                        >
                            Change note
                        </label>
                        <textarea
                            id="publish-change-note"
                            value={changeNote}
                            onChange={(e) => setChangeNote(e.target.value)}
                            placeholder="Describe what changed in this version..."
                            rows={3}
                            className="w-full rounded-xl border border-transparent bg-[var(--blanc-field)] px-3 py-2.5 text-sm text-[var(--blanc-ink-1)] placeholder:text-[var(--blanc-ink-3)] transition-colors focus:outline-none focus:border-[var(--blanc-line-strong)] resize-none"
                        />
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button
                            variant="ghost"
                            onClick={() => handleOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={!canPublish}
                            onClick={handlePublish}
                        >
                            {busy && (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            )}
                            Publish
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

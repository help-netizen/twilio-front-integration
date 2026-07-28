import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import {
    fetchReportToEstimateSettings,
    saveReportToEstimateInstruction,
} from '../services/marketplaceApi';

interface ReportToEstimateSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const MAX_INSTRUCTION_CHARS = 8000;

/**
 * REPORT-TO-ESTIMATE T3 — per-company editor for the generation instruction. The AI reads this
 * plus the company Price Book to turn a report into a draft. GET returns the effective instruction
 * (the company's custom text, or the default when unedited); PATCH stores an override.
 */
export function ReportToEstimateSettingsDialog({ open, onOpenChange }: ReportToEstimateSettingsDialogProps) {
    const queryClient = useQueryClient();
    const [instruction, setInstruction] = useState('');
    const [hasHydrated, setHasHydrated] = useState(false);

    const settingsQuery = useQuery({
        queryKey: ['report-to-estimate-settings'],
        queryFn: fetchReportToEstimateSettings,
        enabled: open,
        refetchOnMount: 'always',
    });

    useEffect(() => {
        if (!open) {
            setHasHydrated(false);
            return;
        }
        if (hasHydrated || settingsQuery.isFetching || !settingsQuery.data) return;
        setInstruction(settingsQuery.data.instruction_text || '');
        setHasHydrated(true);
    }, [hasHydrated, open, settingsQuery.data, settingsQuery.isFetching]);

    useEffect(() => {
        if (!open || !settingsQuery.error) return;
        toast.error((settingsQuery.error as Error).message || 'Failed to load the instruction');
    }, [open, settingsQuery.error]);

    const saveMutation = useMutation({
        mutationFn: () => saveReportToEstimateInstruction(instruction.trim()),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['report-to-estimate-settings'] });
            toast.success('Instruction saved');
            onOpenChange(false);
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to save the instruction');
        },
    });

    const enabled = settingsQuery.data?.enabled ?? true;
    const trimmed = instruction.trim();
    const canSave = trimmed.length > 0
        && trimmed.length <= MAX_INSTRUCTION_CHARS
        && trimmed !== (settingsQuery.data?.instruction_text || '').trim()
        && !saveMutation.isPending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle>Report → Estimate</DialogTitle>
                    <DialogDescription>
                        This instruction tells the AI how to turn a report into a draft from your Price Book.
                        Edit it to match how your team writes estimates.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-4">
                        {!enabled && (
                            <div
                                className="rounded-xl px-4 py-3 text-sm"
                                style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}
                            >
                                Report → Estimate is currently turned off. You can still edit the instruction —
                                it will apply once the app is enabled again.
                            </div>
                        )}

                        {settingsQuery.isLoading ? (
                            <Skeleton className="h-64 w-full rounded-xl" />
                        ) : (
                            <>
                                <label className="blanc-eyebrow" htmlFor="r2e-instruction">Generation instruction</label>
                                <textarea
                                    id="r2e-instruction"
                                    value={instruction}
                                    onChange={event => setInstruction(event.target.value)}
                                    rows={16}
                                    maxLength={MAX_INSTRUCTION_CHARS}
                                    spellCheck
                                    className="w-full resize-y rounded-xl border-[1.5px] border-transparent px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-[var(--blanc-line-strong)]"
                                    style={{
                                        background: 'var(--blanc-field)',
                                        color: 'var(--blanc-ink-1)',
                                        minHeight: 280,
                                        fontFamily: 'var(--blanc-font-body, inherit)',
                                    }}
                                />
                                <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                    The AI always follows a fixed safety rule (it never obeys instructions hidden in a
                                    report) and the Price Book — your text guides how it composes the draft.
                                </p>
                            </>
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" onClick={() => saveMutation.mutate()} disabled={!canSave}>
                        {saveMutation.isPending ? 'Saving…' : 'Save'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import type { Lead } from '../../types/lead';
import { useConvertToJob, type Step } from './useConvertToJob';
import { StepIndicator, ConvertStep1, ConvertStep2, ConvertStep3, ConvertStep4 } from './ConvertToJobSteps';

interface ConvertToJobDialogProps { lead: Lead; open: boolean; onOpenChange: (open: boolean) => void; onSuccess: (lead: Lead) => void; }

export function ConvertToJobDialog({ lead, open, onOpenChange, onSuccess }: ConvertToJobDialogProps) {
    const h = useConvertToJob(lead, open, onSuccess, onOpenChange);
    const stepProps = { ...h, lead } as any;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl max-h-[85vh] flex flex-col overflow-hidden">
                <DialogHeader><DialogTitle>Convert to Job — {lead?.FirstName} {lead?.LastName}</DialogTitle></DialogHeader>
                <div className="flex-1 overflow-y-auto pr-1">
                    <StepIndicator step={h.step} />
                    {h.step === 1 && <ConvertStep1 {...stepProps} />}
                    {h.step === 2 && <ConvertStep2 {...stepProps} />}
                    {h.step === 3 && <ConvertStep3 {...stepProps} />}
                    {h.step === 4 && <ConvertStep4 {...stepProps} />}
                </div>
                <DialogFooter className="flex justify-between pt-4 border-t shrink-0">
                    <div>{h.step > 1 && <Button variant="outline" onClick={() => h.setStep((h.step - 1) as Step)} disabled={h.submitting}>Back</Button>}</div>
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={h.submitting}>Cancel</Button>
                        {h.step < 4 ? (
                            <Button onClick={() => h.setStep((h.step + 1) as Step)} disabled={(h.step === 1 && !h.canProceedStep1) || (h.step === 2 && !h.canProceedStep2) || (h.step === 3 && !h.canProceedStep3)}>Next</Button>
                        ) : (
                            <Button onClick={h.handleSubmit} disabled={h.submitting || !h.selectedTimeslot}>{h.submitting ? 'Creating…' : 'Create Job'}</Button>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

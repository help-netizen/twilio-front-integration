import { Dialog, DialogContent, DialogPanelHeader, DialogBody, DialogPanelFooter, DialogTitle, DialogDescription } from '../ui/dialog';
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
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Convert to job — {lead?.FirstName} {lead?.LastName}
                    </DialogTitle>
                    <DialogDescription className="sr-only">Convert a lead into a scheduled job</DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        <StepIndicator step={h.step} />
                        {h.step === 1 && <ConvertStep1 {...stepProps} />}
                        {h.step === 2 && <ConvertStep2 {...stepProps} />}
                        {h.step === 3 && <ConvertStep3 {...stepProps} />}
                        {h.step === 4 && <ConvertStep4 {...stepProps} />}
                    </div>
                </DialogBody>

                <DialogPanelFooter className="justify-between">
                    <div>{h.step > 1 && <Button variant="outline" onClick={() => h.setStep((h.step - 1) as Step)} disabled={h.submitting}>Back</Button>}</div>
                    <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={h.submitting}>Cancel</Button>
                        {h.step < 4 ? (
                            <Button onClick={() => h.setStep((h.step + 1) as Step)} disabled={(h.step === 1 && !h.canProceedStep1) || (h.step === 2 && !h.canProceedStep2) || (h.step === 3 && !h.canProceedStep3)}>Next</Button>
                        ) : (
                            <Button onClick={h.handleSubmit} disabled={h.submitting || !h.selectedTimeslot}>{h.submitting ? 'Creating…' : 'Create job'}</Button>
                        )}
                    </div>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

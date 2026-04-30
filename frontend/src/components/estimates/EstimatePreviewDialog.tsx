import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Separator } from '../ui/separator';
import type { Estimate, EstimateItem } from '../../services/estimatesApi';

export const DEFAULT_TERMS_AND_WARRANTY = `TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.

WARRANTY:
- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.
- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer's standard warranty is shorter.
- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.
- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.`;

function money(value: string | number | null | undefined): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function itemMeta(item: EstimateItem): string {
    const qty = Number(item.quantity || 1);
    if (qty === 1) return money(item.unit_price);
    return `${qty} x ${money(item.unit_price)}`;
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimate: Estimate;
}

export function EstimatePreviewDialog({ open, onOpenChange, estimate }: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-white">
                <DialogHeader>
                    <DialogTitle className="font-mono text-base">{estimate.estimate_number}</DialogTitle>
                </DialogHeader>

                <div className="space-y-6 text-sm text-neutral-900">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <p className="text-xs uppercase tracking-wide text-neutral-500">Prepared for</p>
                            <p className="font-medium">{estimate.contact_name || 'Customer'}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-xs uppercase tracking-wide text-neutral-500">Total</p>
                            <p className="font-mono text-xl font-semibold">{money(estimate.total)}</p>
                        </div>
                    </div>

                    {estimate.summary && (
                        <section>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Summary</h3>
                            <p className="whitespace-pre-wrap leading-6">{estimate.summary}</p>
                        </section>
                    )}

                    <section>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Items</h3>
                        <div className="divide-y border-y">
                            {(estimate.items || []).map(item => (
                                <div key={item.id} className="grid grid-cols-[1fr_auto] gap-4 py-3">
                                    <div>
                                        <p className="font-medium">{item.name}</p>
                                        {item.description && <p className="mt-1 whitespace-pre-wrap text-neutral-600">{item.description}</p>}
                                        <p className="mt-1 text-xs text-neutral-500">{itemMeta(item)}</p>
                                    </div>
                                    <p className="font-mono font-medium">{money(item.amount)}</p>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="ml-auto max-w-xs space-y-2">
                        <div className="flex justify-between">
                            <span className="text-neutral-500">Subtotal</span>
                            <span className="font-mono">{money(estimate.subtotal)}</span>
                        </div>
                        {Number(estimate.discount_amount || 0) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-neutral-500">Discount</span>
                                <span className="font-mono">-{money(estimate.discount_amount)}</span>
                            </div>
                        )}
                        {Number(estimate.tax_amount || 0) > 0 && (
                            <div className="flex justify-between">
                                <span className="text-neutral-500">Tax</span>
                                <span className="font-mono">{money(estimate.tax_amount)}</span>
                            </div>
                        )}
                        <Separator />
                        <div className="flex justify-between font-semibold">
                            <span>Total</span>
                            <span className="font-mono">{money(estimate.total)}</span>
                        </div>
                    </section>

                    <section>
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Terms & Warranty</h3>
                        <p className="whitespace-pre-wrap leading-6 text-neutral-700">{DEFAULT_TERMS_AND_WARRANTY}</p>
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}

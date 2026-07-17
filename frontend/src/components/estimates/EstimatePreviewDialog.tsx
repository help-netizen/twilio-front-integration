import { FloatingDetailPanel } from '../ui/FloatingDetailPanel';
import type { Estimate, EstimateItem } from '../../services/estimatesApi';
import { useDocumentTemplate } from '../../hooks/useDocumentTemplate';
import { TemplateLivePreview, type PreviewEstimate } from '../documents/TemplateLivePreview';

/**
 * Last-resort fallback used only when the document templates API is unreachable.
 * The canonical text lives in the company's `document_templates` row (F015).
 */
export const DEFAULT_TERMS_AND_WARRANTY = `TERMS: Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.

WARRANTY:
- 90-day labor warranty covering workmanship and the completed repair, starting from the date the repair is finished.
- OEM parts warranty is extended to a minimum of 90 days, even if the manufacturer's standard warranty is shorter.
- A service visit during the warranty period is provided at no additional charge if the issue is related to the repaired component or workmanship.
- Warranty does not cover misuse, physical damage, power issues, water damage, improper installation, or failures unrelated to the replaced component.`;

function mapEstimateForPreview(estimate: Estimate): PreviewEstimate {
    return {
        estimate_number: estimate.estimate_number || 'ESTIMATE',
        status: estimate.status || 'draft',
        contact_name: estimate.contact_name || 'Customer',
        contact_email: estimate.contact_email || '',
        contact_phone: estimate.contact_phone || '',
        billing_address: estimate.billing_address || estimate.service_address || '',
        service_address: estimate.service_address || estimate.billing_address || '',
        summary: estimate.summary || '',
        subtotal: Number(estimate.subtotal || 0),
        discount_amount: Number(estimate.discount_amount || 0),
        tax_amount: Number(estimate.tax_amount || 0),
        total: Number(estimate.total || 0),
        items: (estimate.items || []).map((it: EstimateItem) => ({
            id: it.id,
            name: it.name || 'Item',
            description: it.description ?? null,
            quantity: Number(it.quantity || 1),
            unit_price: Number(it.unit_price || 0),
            amount: Number(it.amount || 0),
        })),
        created_at: estimate.created_at || new Date().toISOString(),
        updated_at: estimate.updated_at || estimate.created_at || new Date().toISOString(),
    };
}

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    estimate: Estimate;
}

export function EstimatePreviewDialog({ open, onOpenChange, estimate }: Props) {
    const descriptor = useDocumentTemplate('estimate', open);
    const data = mapEstimateForPreview(estimate);
    return (
        <FloatingDetailPanel open={open} onClose={() => onOpenChange(false)} wide>
            <div className="flex h-full min-h-0 flex-col bg-white text-[#172033]">
                <div className="shrink-0 border-b border-[#d8e0ea] bg-[#fbfcfe] px-5 py-4 pr-14">
                    <p className="font-mono text-sm font-semibold">{estimate.estimate_number}</p>
                    <p className="text-xs text-[#5f7085] mt-0.5">Preview</p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-5">
                    {descriptor ? (
                        <TemplateLivePreview descriptor={descriptor} estimate={data} />
                    ) : (
                        <div className="py-12 text-center text-sm text-neutral-500">Loading template…</div>
                    )}
                </div>
            </div>
        </FloatingDetailPanel>
    );
}

import { format } from 'date-fns';
import type { Lead } from '../../types/lead';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import { LeadActionButtons } from './LeadActionButtons';

export function MetadataSection({ lead }: { lead: Lead }) {
    const { customFields } = useLeadFormSettings();

    // Only show fields that have data
    const filledCustomFields = customFields.filter(f => lead.Metadata?.[f.api_name]);
    const hasCreatedDate = !!lead.CreatedDate;

    if (!hasCreatedDate && filledCustomFields.length === 0) return null;

    return (
        <div>
            <h4 className="blanc-eyebrow mb-2">Metadata</h4>
            <div className="space-y-2">
                {hasCreatedDate && (
                    <div>
                        <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Created</div>
                        <div className="text-sm font-medium" style={{ color: 'var(--blanc-ink-1)' }}>
                            {format(new Date(lead.CreatedDate!), 'MMM dd, yyyy HH:mm')}
                        </div>
                    </div>
                )}
                {filledCustomFields.map(field => (
                    <div key={field.id}>
                        <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{field.display_name}</div>
                        <div className="text-sm font-medium whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>
                            {lead.Metadata?.[field.api_name]}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

interface FooterProps {
    lead: Lead;
    onEdit: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    onDelete: (uuid: string) => void;
}

export function LeadDetailFooter({ lead, onEdit, onMarkLost, onActivate, onConvert, onDelete }: FooterProps) {
    return (
        <div className="px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))] shrink-0" style={{ background: 'var(--blanc-surface-strong)', borderTop: '1px solid var(--blanc-line)' }}>
            <LeadActionButtons
                lead={lead}
                variant="footer"
                onEdit={onEdit}
                onMarkLost={onMarkLost}
                onActivate={onActivate}
                onConvert={onConvert}
                onDelete={onDelete}
            />
        </div>
    );
}

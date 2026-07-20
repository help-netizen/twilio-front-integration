import type { Lead } from '../../types/lead';
import { PulsePinnedBar, PulsePinnedBarExpand } from '../pulse/PulsePinnedBar';
import { LeadActionButtons } from './LeadActionButtons';
import { LeadStatusDropdown } from './LeadStatusDropdown';

interface PulseLeadBarProps {
    lead: Lead;
    onEdit: (lead: Lead) => void;
    onMarkLost: (uuid: string) => void;
    onActivate: (uuid: string) => void;
    onConvert: (uuid: string) => void;
    onUpdateStatus: (uuid: string, status: string) => void;
    onDelete: (uuid: string) => void;
    onExpand: () => void;
}

export function PulseLeadBar({
    lead, onEdit, onMarkLost, onActivate, onConvert, onUpdateStatus, onDelete, onExpand,
}: PulseLeadBarProps) {
    const contactName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'Unknown';

    return (
        <PulsePinnedBar entityLabel="Lead" accent="var(--blanc-info)" className="pulse-lead-bar">
            <div className="pulse-lead-bar-identity">
                <p className="pulse-lead-bar-kicker">
                    Lead
                    {lead.SerialId && <span className="font-mono"> #{lead.SerialId}</span>}
                    {lead.JobType && <span className="pulse-lead-bar-repair-type">{lead.JobType}</span>}
                </p>
                <div className="pulse-lead-bar-name-row">
                    <h2 className="pulse-lead-bar-name" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{contactName}</h2>
                    <LeadStatusDropdown lead={lead} onUpdateStatus={onUpdateStatus} compact />
                </div>
            </div>

            <LeadActionButtons
                lead={lead}
                variant="bar"
                onEdit={onEdit}
                onMarkLost={onMarkLost}
                onActivate={onActivate}
                onConvert={onConvert}
                onDelete={onDelete}
            />

            <PulsePinnedBarExpand label="Open full lead card" onClick={onExpand} />
        </PulsePinnedBar>
    );
}

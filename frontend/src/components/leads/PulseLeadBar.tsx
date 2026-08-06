import type { Lead } from '../../types/lead';
import { PulsePinnedBar } from '../pulse/PulsePinnedBar';
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
                    {/* Tapping the name opens the full lead card — replaces the removed chevron
                        (owner). The status dropdown stays a separate control beside it. */}
                    <h2
                        className="pulse-lead-bar-name is-expandable"
                        style={{ fontFamily: 'var(--blanc-font-heading)' }}
                        role="button"
                        tabIndex={0}
                        aria-label="Open full lead card"
                        onClick={onExpand}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(); } }}
                    >{contactName}</h2>
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
        </PulsePinnedBar>
    );
}

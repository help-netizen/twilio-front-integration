/**
 * LeadMobileCard — a single Leads tile for the mobile Leads list (LEADS-MOBILE-001).
 *
 * Mirrors JobMobileCard but reads a `Lead`. Composition:
 *   Row 1: name hero (FirstName LastName, fallback Company, else "No name")
 *          + worded status chip top-right (colored via getLeadStatusPillStyle)
 *   Row 2: phone (formatPhoneDisplay), plain text — tapping the tile opens the
 *          detail, so there is NO call button / tel: link.
 *   Row 3: "JobType · JobSource"
 *   left 4px border = LEAD_STATUS_COLORS[Status] (fallback gray) · LeadLost → opacity .6
 *
 * No id, no email, no address (all kept in the detail panel). Desktop is
 * unaffected — this is rendered only inside LeadsMobileList, which LeadsPage
 * mounts behind useIsMobile.
 */

import React from 'react';
import type { Lead } from '../../types/lead';
import { formatPhoneDisplay } from '../../utils/phoneUtils';
import { LEAD_STATUS_COLORS, getLeadStatusPillStyle } from './leadStatusStyles';
import { useAuthz } from '../../hooks/useAuthz';

interface LeadMobileCardProps {
    lead: Lead;
    onClick: (lead: Lead) => void;
}

export const LeadMobileCard: React.FC<LeadMobileCardProps> = ({ lead, onClick }) => {
    const { hasPermission } = useAuthz();
    const canViewSource = hasPermission('lead_source.view');
    const accent = LEAD_STATUS_COLORS[lead.Status] || 'var(--blanc-ink-3, rgba(117, 106, 89, 0.6))';
    const isLost = !!lead.LeadLost;

    const name = `${lead.FirstName || ''} ${lead.LastName || ''}`.trim() || lead.Company || 'No name';
    const phone = lead.Phone ? formatPhoneDisplay(lead.Phone) : '';
    const typeSource = [lead.JobType, canViewSource ? lead.JobSource : null].filter(Boolean).join(' · ');

    const pill = getLeadStatusPillStyle(lead.Status);

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onClick(lead)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(lead); } }}
            className={`
                relative w-full text-left overflow-hidden transition-shadow cursor-pointer
                hover:shadow-xl
                focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 outline-none
                ${isLost ? 'opacity-60' : ''}
            `}
            style={{
                background: 'var(--blanc-surface-strong, #fffdf9)',
                border: '1px solid var(--blanc-line, var(--blanc-line))',
                borderLeft: `4px solid ${accent}`,
                borderRadius: '18px',
                boxShadow: 'var(--blanc-shadow-card, 0 6px 16px rgba(48, 39, 28, 0.06))',
            }}
        >
            <div className="p-3.5 pb-3 flex flex-col gap-1" style={{ paddingLeft: '14px' }}>
                {/* Row 1: name hero (left) + status chip (right) */}
                <div className="flex items-start justify-between gap-2" style={{ minWidth: 0 }}>
                    <h3
                        className="font-semibold truncate"
                        style={{ fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.03em', fontSize: '17px', color: 'var(--blanc-ink-1)', margin: 0, minWidth: 0 }}
                    >
                        {name}
                    </h3>
                    <span
                        className="inline-flex items-center self-start rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap flex-shrink-0"
                        style={{ background: pill.bg, color: pill.color, border: `1px solid ${pill.border}` }}
                    >
                        {lead.Status}
                    </span>
                </div>

                {/* Row 2: phone — plain text (no tel: link; tap opens detail) */}
                {phone && (
                    <span className="text-[14px] truncate" style={{ color: 'var(--blanc-ink-2)' }}>
                        {phone}
                    </span>
                )}

                {/* Row 3: "JobType · JobSource" */}
                {typeSource && (
                    <span className="text-[13px] truncate" style={{ color: 'var(--blanc-ink-3)' }}>
                        {typeSource}
                    </span>
                )}
            </div>
        </div>
    );
};

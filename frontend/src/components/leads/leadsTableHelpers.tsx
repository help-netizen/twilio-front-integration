import React from 'react';
import { TableCell } from '../ui/table';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { Copy } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';
import { getLeadStatusPillStyle } from './leadStatusStyles';

export function handleCopyPhone(phone: string, e: React.MouseEvent) { e.stopPropagation(); navigator.clipboard.writeText(phone); toast.success('Phone number copied to clipboard'); }

// SOURCE-PERM-001: `canViewSource` gates the jobSource cell. `renderCell` is
// called inside LeadsTable's `visibleColumns.map(...)`, so it can't use the
// useAuthz() hook itself (rules-of-hooks / variable column count). The caller
// must compute `canViewSource = hasPermission('lead_source.view')` and pass it.
// Defaults to `true` so callers that haven't been updated keep prior behavior.
export function renderCell(columnId: string, lead: Lead, key: string, canViewSource = true) {
    const cellStyle = { padding: '12px 16px' };

    switch (columnId) {
        case 'status': {
            const st = getLeadStatusPillStyle(lead.Status);
            return (
                <TableCell key={key} style={cellStyle}>
                    <span
                        className="inline-flex items-center px-3 text-xs font-semibold"
                        style={{ backgroundColor: st.bg, color: st.color, border: `1px solid ${st.border}`, minHeight: 28, borderRadius: 8 }}
                    >
                        {lead.Status}
                    </span>
                </TableCell>
            );
        }
        case 'name':
            return (
                <TableCell key={key} style={cellStyle}>
                    <div>
                        <div className="font-semibold text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                            {lead.FirstName} {lead.LastName}
                        </div>
                        {lead.Company && (
                            <div className="text-xs mt-0.5" style={{ color: 'var(--blanc-ink-3)' }}>{lead.Company}</div>
                        )}
                    </div>
                </TableCell>
            );
        case 'phone':
            return (
                <TableCell key={key} style={cellStyle}>
                    {lead.Phone ? (
                        <div className="flex items-center gap-1.5">
                            <a
                                href={`tel:${lead.Phone}`}
                                className="font-mono text-sm no-underline"
                                style={{ color: 'var(--blanc-ink-1)' }}
                                onClick={e => e.stopPropagation()}
                            >
                                {formatPhone(lead.Phone)}
                            </a>
                            <button
                                onClick={e => handleCopyPhone(lead.Phone!, e)}
                                className="inline-flex items-center justify-center transition-opacity hover:opacity-60"
                                style={{ width: 26, height: 26, borderRadius: 8, color: 'var(--blanc-ink-3)' }}
                            >
                                <Copy className="size-3" />
                            </button>
                        </div>
                    ) : null}
                </TableCell>
            );
        case 'email':
            return (
                <TableCell key={key} style={cellStyle}>
                    {lead.Email ? (
                        <a
                            href={`mailto:${lead.Email}`}
                            className="text-sm no-underline"
                            style={{ color: 'var(--blanc-ink-1)' }}
                            onClick={e => e.stopPropagation()}
                        >
                            {lead.Email}
                        </a>
                    ) : null}
                </TableCell>
            );
        case 'location': {
            const loc = [lead.City, lead.State, lead.PostalCode].filter(Boolean).join(', ');
            return <TableCell key={key} style={{ ...cellStyle, color: 'var(--blanc-ink-2)' }} className="text-sm">{loc || null}</TableCell>;
        }
        case 'jobType':
            return <TableCell key={key} style={{ ...cellStyle, color: 'var(--blanc-ink-2)' }} className="text-sm">{lead.JobType || null}</TableCell>;
        case 'jobSource':
            return <TableCell key={key} style={{ ...cellStyle, color: 'var(--blanc-ink-2)' }} className="text-sm">{canViewSource ? (lead.JobSource || null) : null}</TableCell>;
        case 'created':
            return <TableCell key={key} style={{ ...cellStyle, color: 'var(--blanc-ink-3)' }} className="text-sm">{lead.CreatedDate ? format(new Date(lead.CreatedDate), 'MMM dd, yyyy') : null}</TableCell>;
        case 'serialId':
            return <TableCell key={key} style={{ ...cellStyle, color: 'var(--blanc-ink-3)' }} className="font-mono text-xs">{lead.SerialId}</TableCell>;
        case 'contact':
            return <TableCell key={key} style={cellStyle}>{lead.ContactName ? <span className="text-sm font-medium" style={{ color: 'var(--blanc-info)' }}>{lead.ContactName}</span> : null}</TableCell>;
        default:
            return <TableCell key={key} style={cellStyle} />;
    }
}

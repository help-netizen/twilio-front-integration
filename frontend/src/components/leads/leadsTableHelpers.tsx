import React from 'react';
import { TableCell } from '../ui/table';
import { formatPhoneDisplay as formatPhone } from '../../utils/phoneUtils';
import { Copy } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';

// ── Status badge colors (Blanc warm palette) ──────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
    'New':            { bg: 'rgba(37, 99, 235, 0.1)',  color: '#2563eb' },
    'Submitted':      { bg: 'rgba(37, 99, 235, 0.1)',  color: '#2563eb' },
    'Contacted':      { bg: 'rgba(27, 139, 99, 0.1)',  color: '#1b8b63' },
    'Qualified':      { bg: 'rgba(124, 58, 237, 0.1)', color: '#7c3aed' },
    'Proposal Sent':  { bg: 'rgba(124, 58, 237, 0.1)', color: '#7c3aed' },
    'Negotiation':    { bg: 'rgba(234, 179, 8, 0.1)',  color: '#ca8a04' },
    'Converted':      { bg: 'rgba(27, 139, 99, 0.08)', color: 'var(--blanc-ink-3)' },
    'Lost':           { bg: 'rgba(212, 77, 60, 0.1)',  color: '#d44d3c' },
};

function getStatusStyle(status: string) {
    return STATUS_STYLES[status] || { bg: 'rgba(117, 106, 89, 0.08)', color: 'var(--blanc-ink-2)' };
}

export function handleCopyPhone(phone: string, e: React.MouseEvent) { e.stopPropagation(); navigator.clipboard.writeText(phone); toast.success('Phone number copied to clipboard'); }
export function handleCall(phone: string, e: React.MouseEvent) { e.stopPropagation(); window.location.href = `tel:${phone}`; }

export function renderCell(columnId: string, lead: Lead, key: string) {
    const cellStyle = { padding: '12px 16px' };

    switch (columnId) {
        case 'status': {
            const st = getStatusStyle(lead.Status);
            return (
                <TableCell key={key} style={cellStyle}>
                    <span
                        className="inline-flex items-center px-3 text-xs font-semibold"
                        style={{ backgroundColor: st.bg, color: st.color, minHeight: 28, borderRadius: 8 }}
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
            return <TableCell key={key} style={{ ...cellStyle, color: 'var(--blanc-ink-2)' }} className="text-sm">{lead.JobSource || null}</TableCell>;
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

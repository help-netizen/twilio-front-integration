import React from 'react';
import { TableCell } from '../ui/table';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { formatPhone } from '../../lib/formatPhone';
import { Copy } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import type { Lead } from '../../types/lead';

export function getStatusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
    switch (status) {
        case 'New': case 'Submitted': return 'default';
        case 'Contacted': return 'secondary';
        case 'Qualified': case 'Proposal Sent': case 'Negotiation': return 'default';
        case 'Converted': return 'outline';
        case 'Lost': return 'destructive';
        default: return 'secondary';
    }
}

export function handleCopyPhone(phone: string, e: React.MouseEvent) { e.stopPropagation(); navigator.clipboard.writeText(phone); toast.success('Phone number copied to clipboard'); }
export function handleCall(phone: string, e: React.MouseEvent) { e.stopPropagation(); window.location.href = `tel:${phone}`; }

export function renderCell(columnId: string, lead: Lead, key: string) {
    switch (columnId) {
        case 'status': return <TableCell key={key}><Badge variant={getStatusBadgeVariant(lead.Status)}>{lead.Status}</Badge></TableCell>;
        case 'name': return <TableCell key={key}><div><div className="font-medium">{lead.FirstName} {lead.LastName}</div>{lead.Company && <div className="text-sm text-muted-foreground">{lead.Company}</div>}</div></TableCell>;
        case 'phone': return <TableCell key={key}><div className="flex items-center gap-2">{lead.Phone ? <a href={`tel:${lead.Phone}`} className="font-mono text-sm text-inherit no-underline hover:text-inherit" onClick={e => e.stopPropagation()}>{formatPhone(lead.Phone)}</a> : <span className="font-mono text-sm">-</span>}{lead.Phone && <Button variant="ghost" size="sm" className="size-7 p-0" onClick={e => handleCopyPhone(lead.Phone!, e)}><Copy className="size-3" /></Button>}</div></TableCell>;
        case 'email': return <TableCell key={key}>{lead.Email ? <a href={`mailto:${lead.Email}`} className="text-sm text-inherit no-underline hover:text-inherit" onClick={e => e.stopPropagation()}>{lead.Email}</a> : '-'}</TableCell>;
        case 'location': return <TableCell key={key}>{(lead.City || lead.State || lead.PostalCode) ? [lead.City, lead.State, lead.PostalCode].filter(Boolean).join(', ') : '-'}</TableCell>;
        case 'jobType': return <TableCell key={key}>{lead.JobType || '-'}</TableCell>;
        case 'jobSource': return <TableCell key={key}>{lead.JobSource || '-'}</TableCell>;
        case 'created': return <TableCell key={key}>{lead.CreatedDate ? format(new Date(lead.CreatedDate), 'MMM dd, yyyy HH:mm') : '-'}</TableCell>;
        case 'serialId': return <TableCell key={key}><span className="font-mono text-sm">{lead.SerialId}</span></TableCell>;
        case 'contact': return <TableCell key={key}>{lead.ContactName ? <span className="text-sm" style={{ color: '#4f46e5', fontWeight: 500 }}>{lead.ContactName}</span> : '-'}</TableCell>;
        default: return <TableCell key={key}>-</TableCell>;
    }
}

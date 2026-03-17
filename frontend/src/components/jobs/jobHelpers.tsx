import type { LocalJob, JobTag } from '../../services/jobsApi';

// ─── Constants ───────────────────────────────────────────────────────────────

export const BLANC_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
];

export const BLANC_STATUS_COLORS: Record<string, string> = {
    'Submitted': '#3B82F6',
    'Waiting for parts': '#F59E0B',
    'Follow Up with Client': '#8B5CF6',
    'Visit completed': '#22C55E',
    'Job is Done': '#6B7280',
    'Rescheduled': '#F97316',
    'Canceled': '#EF4444',
};

export const ZB_STATUS_COLORS: Record<string, string> = {
    scheduled: 'bg-blue-50 text-blue-600 border border-blue-200',
    'en-route': 'bg-amber-50 text-amber-600 border border-amber-200',
    'in-progress': 'bg-green-50 text-green-600 border border-green-200',
    complete: 'bg-gray-50 text-gray-600 border border-gray-200',
};

// ─── Utility Functions ───────────────────────────────────────────────────────

export function getContrastText(hex: string): string {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000' : '#fff';
}

export function formatSchedule(startIso?: string | null, endIso?: string | null): { date: string; time: string } {
    if (!startIso) return { date: '—', time: '' };
    try {
        const start = new Date(startIso);
        const date = new Intl.DateTimeFormat('en-US', {
            weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
        }).format(start);
        const startTime = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', minute: '2-digit',
        }).format(start);
        if (endIso) {
            const end = new Date(endIso);
            const endTime = new Intl.DateTimeFormat('en-US', {
                hour: 'numeric', minute: '2-digit',
            }).format(end);
            return { date, time: `${startTime} - ${endTime}` };
        }
        return { date, time: startTime };
    } catch { return { date: startIso, time: '' }; }
}

// ─── Badge Components ────────────────────────────────────────────────────────

export function TagBadge({ tag, small }: { tag: JobTag; small?: boolean }) {
    const textColor = getContrastText(tag.color);
    const isWhite = tag.color.toLowerCase() === '#ffffff' || tag.color.toLowerCase() === '#fff';
    return (
        <span
            className={`inline-flex items-center rounded-full font-medium ${small ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'}`}
            style={{
                backgroundColor: tag.color,
                color: textColor,
                border: isWhite ? '1px solid #d1d5db' : 'none',
            }}
        >
            {tag.name}
        </span>
    );
}

export function BlancBadge({ status }: { status: string }) {
    const dotColor = BLANC_STATUS_COLORS[status] || '#9CA3AF';
    return (
        <span className="inline-flex items-center gap-1.5 px-1 py-0.5 text-sm font-medium text-gray-700">
            <span className="shrink-0 rounded-full" style={{ backgroundColor: dotColor, width: 10, height: 10 }} />
            {status}
        </span>
    );
}

export function ZbBadge({ status }: { status: string }) {
    const cls = ZB_STATUS_COLORS[status] || 'bg-gray-50 text-gray-500 border border-gray-200';
    return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
            zb: {status}
        </span>
    );
}

// ─── Column Definitions ──────────────────────────────────────────────────────

export interface ColumnDef {
    key: string;
    label: string;
    sortKey?: string;
    width?: string;
    render: (job: LocalJob) => React.ReactNode;
}

/** Build a dynamic column for a metadata custom field */
export function makeMetaColumn(apiName: string, displayName: string): ColumnDef {
    return {
        key: `meta:${apiName}`,
        label: displayName,
        sortKey: `meta:${apiName}`,
        render: (j) => <span className="line-clamp-2 text-xs">{j.metadata?.[apiName] || '—'}</span>,
    };
}

export const STATIC_COLUMNS: Record<string, ColumnDef> = {
    job_number: {
        key: 'job_number', label: '#', sortKey: 'job_number', width: 'w-20',
        render: (j) => <span className="font-mono text-xs text-muted-foreground">{j.job_number || '—'}</span>,
    },
    customer_name: {
        key: 'customer_name', label: 'Customer', sortKey: 'customer_name', width: 'w-48 max-w-[12rem]',
        render: (j) => (
            <div className="max-w-[12rem]">
                <div className="font-medium truncate">{j.customer_name || '—'}</div>
                {j.customer_phone && <div className="text-xs text-muted-foreground">{j.customer_phone}</div>}
            </div>
        ),
    },
    customer_phone: {
        key: 'customer_phone', label: 'Phone', sortKey: 'customer_phone',
        render: (j) => <span>{j.customer_phone || '—'}</span>,
    },
    customer_email: {
        key: 'customer_email', label: 'Email', sortKey: 'customer_email',
        render: (j) => <span className="truncate max-w-[10rem] block">{j.customer_email || '—'}</span>,
    },
    service_name: {
        key: 'service_name', label: 'Service', sortKey: 'service_name', width: 'w-40 max-w-[10rem]',
        render: (j) => <span className="truncate max-w-[10rem] block">{j.service_name || '—'}</span>,
    },
    blanc_status: {
        key: 'blanc_status', label: 'Status', sortKey: 'blanc_status',
        render: (j) => (
            <div className="flex flex-col gap-1">
                <BlancBadge status={j.blanc_status} />
                <ZbBadge status={j.zb_status} />
            </div>
        ),
    },
    zb_status: {
        key: 'zb_status', label: 'ZB Status', sortKey: 'zb_status',
        render: (j) => <ZbBadge status={j.zb_status} />,
    },
    tags: {
        key: 'tags', label: 'Tags',
        render: (j) => (
            <div className="flex flex-wrap gap-1" title={j.tags?.length ? j.tags.map((t: any) => t.name).join(', ') : ''}>
                {j.tags?.length ? j.tags.map((t: JobTag) => <TagBadge key={t.id} tag={t} small />) : <span className="text-xs text-muted-foreground">—</span>}
            </div>
        ),
    },
    assigned_techs: {
        key: 'assigned_techs', label: 'Techs',
        render: (j) => <span>{j.assigned_techs?.map((p: any) => p.name).join(', ') || '—'}</span>,
    },
    start_date: {
        key: 'start_date', label: 'Schedule', sortKey: 'start_date',
        render: (j) => {
            const s = formatSchedule(j.start_date, j.end_date);
            return <div className="text-xs"><div className="whitespace-nowrap">{s.date}</div>{s.time && <div className="text-muted-foreground whitespace-nowrap">{s.time}</div>}</div>;
        },
    },
    address: {
        key: 'address', label: 'Address', sortKey: 'address',
        render: (j) => <span className="line-clamp-2 text-xs">{j.address || '—'}</span>,
    },
    territory: {
        key: 'territory', label: 'Territory', sortKey: 'territory',
        render: (j) => <span className="line-clamp-2 text-xs">{j.territory || '—'}</span>,
    },
    invoice_total: {
        key: 'invoice_total', label: 'Invoice', sortKey: 'invoice_total',
        render: (j) => <span>{j.invoice_total != null ? `$${Number(j.invoice_total).toFixed(2)}` : '—'}</span>,
    },
    invoice_status: {
        key: 'invoice_status', label: 'Inv. Status', sortKey: 'invoice_status',
        render: (j) => <span>{j.invoice_status || '—'}</span>,
    },
    job_type: {
        key: 'job_type', label: 'Job Type', sortKey: 'job_type',
        render: (j) => <span>{j.job_type || '—'}</span>,
    },
    description: {
        key: 'description', label: 'Description', sortKey: 'description',
        render: (j) => <span className="line-clamp-2 text-xs">{j.description || '—'}</span>,
    },
    comments: {
        key: 'comments', label: 'Comments', sortKey: 'comments',
        render: (j) => <span className="line-clamp-2 text-xs">{j.comments || '—'}</span>,
    },
    job_source: {
        key: 'job_source', label: 'Source', sortKey: 'job_source',
        render: (j) => j.job_source ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted">{j.job_source}</span>
        ) : <span className="text-xs text-muted-foreground">—</span>,
    },
    created_at: {
        key: 'created_at', label: 'Created', sortKey: 'created_at',
        render: (j) => <span className="text-xs whitespace-nowrap">{formatSchedule(j.created_at).date}</span>,
    },
    updated_at: {
        key: 'updated_at', label: 'Updated', sortKey: 'updated_at',
        render: (j) => <span className="text-xs whitespace-nowrap">{formatSchedule(j.updated_at).date}</span>,
    },
};

export const STATIC_FIELD_KEYS = Object.keys(STATIC_COLUMNS);

export const DEFAULT_VISIBLE_FIELDS = [
    'job_number', 'customer_name', 'service_name', 'blanc_status',
    'tags', 'assigned_techs', 'start_date',
];

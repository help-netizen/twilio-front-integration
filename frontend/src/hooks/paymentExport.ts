import { authedFetch } from '../services/apiClient';

const API_BASE = import.meta.env.VITE_API_URL || '';

function escapeCsv(val: string): string {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`;
    return val;
}

export async function exportPaymentsCSV(dateFrom: string, dateTo: string): Promise<void> {
    // Export the full date range with no method/search filter — CSV must
    // reflect every payment in the period regardless of on-screen filters.
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });

    const res = await authedFetch(`${API_BASE}/api/zenbooker/payments/export?${qs.toString()}`);
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Export failed');

    const exportRows: Record<string, string>[] = json.data;
    const headers = ['Job #', 'Client', 'Job Type', 'Status', 'Payment Methods', 'Amount Paid', 'Tags', 'Date', 'Source', 'Tech', 'Claim ID and Other'];
    const csvRows = exportRows.map(r => [
        r.job_number || '', r.client || '', r.job_type || '', r.status || '',
        r.payment_methods || '', r.amount_paid || '', r.tags || '',
        r.payment_date || '', r.source || '', r.tech || '', r.custom_fields || '',
    ]);
    const csv = [headers.map(escapeCsv).join(','), ...csvRows.map(row => row.map(escapeCsv).join(','))].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments_${dateFrom}_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaymentRow {
    id: number;
    job_number: string;
    client: string;
    job_type: string;
    status: string;
    payment_methods: string;
    display_payment_method: string;
    amount_paid: string;
    tags: string;
    payment_date: string;
    source: string;
    tech: string;
    transaction_id: string;
    invoice_id: string;
    job_id: string;
    local_job_id: number | null;
    transaction_status: string;
    missing_job_link: boolean;
    invoice_status: string | null;
    invoice_total: string | null;
    invoice_amount_paid: string | null;
    invoice_amount_due: string | null;
    invoice_paid_in_full: boolean;
    check_deposited: boolean;
    custom_fields: string;
}

interface Provider {
    id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
}

interface Attachment {
    url: string;
    kind: 'image' | 'file';
    source: string;
    note_id: string | null;
    filename: string;
}

export interface PaymentDetail extends Omit<PaymentRow, 'check_deposited'> {
    id: number;
    check_deposited: boolean;
    invoice: {
        status: string;
        total: string;
        amount_paid: string;
        amount_due: string;
        paid_in_full: boolean;
    } | null;
    job: {
        job_number: string | null;
        service_name: string | null;
        service_address: string | null;
        providers: Provider[];
    } | null;
    attachments: Attachment[];
    metadata: {
        transaction_id: string;
        invoice_id: string | null;
        customer_id: string | null;
        territory_id: string | null;
        initiated_by: string | null;
        team_member_id: string | null;
        memo: string | null;
    };
    _warning: string | null;
}

export type SortField = 'payment_date' | 'amount_paid' | 'invoice_amount_due' | 'job_number' | 'client' | 'payment_methods' | 'tech';
export type SortDir = 'asc' | 'desc';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatPaymentDate(iso: string, tz: string = 'America/New_York'): string {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleString('en-US', {
            timeZone: tz,
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    } catch {
        return iso;
    }
}

export function defaultDateFrom(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

export function defaultDateTo(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function formatCurrency(amount: string): string {
    const n = parseFloat(amount);
    if (isNaN(n)) return '$0.00';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function paymentMethodIcon(method: string): string {
    const m = method.toLowerCase();
    if (m.includes('stripe') || m.includes('card') || m.includes('credit')) return '💳';
    if (m.includes('cash')) return '💵';
    if (m.includes('check')) return '📝';
    if (m.includes('venmo')) return '📱';
    if (m.includes('zelle')) return '⚡';
    return '💰';
}

// ── Columns definition ───────────────────────────────────────────────────────

export const COLUMNS: { key: keyof PaymentRow; label: string; sortable?: boolean; className?: string }[] = [
    { key: 'payment_date', label: 'Date', sortable: true },
    { key: 'amount_paid', label: 'Amount', sortable: true, className: 'amount-cell' },
    { key: 'invoice_amount_due', label: 'Due', sortable: true, className: 'due-cell' },
    { key: 'payment_methods', label: 'Method', sortable: true },
    { key: 'job_number', label: 'Job #', sortable: true },
    { key: 'client', label: 'Customer', sortable: true },
    { key: 'tech', label: 'Provider', sortable: true },
];

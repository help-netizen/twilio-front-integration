/**
 * OB-70 invoice card harness — the REAL InvoiceDetailPanel against a stubbed API, so the
 * surface the removal lives on can be judged: one destructive action in the menu instead
 * of the old Delete-draft / Void pair, and the line that explains money the card is not
 * showing ("Job credit … not applied to this invoice").
 *
 * Run:  npx vite (frontend/)  →  /harness.html   (point harness.html here)
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { InvoiceDetailPanel } from '../components/invoices/InvoiceDetailPanel';

const invoice = {
    id: 42,
    company_id: 'demo',
    invoice_number: 'INVOICE 1668-2',
    status: 'draft',
    contact_id: 4093,
    contact_name: 'Richard Fitzgerald',
    contact_email: 'richard@example.com',
    contact_phone: '+15085550142',
    job_id: 1635,
    job_number: '1635',
    lead_id: null,
    notes: 'Dishwasher not draining — pump replaced, drain line cleared and tested.',
    items: [
        { id: 1, name: 'Diagnostic visit', description: 'Inspection and written findings.', quantity: '1', unit_price: '95.00', taxable: true, sort_order: 0 },
        { id: 2, name: 'Drain pump replacement', description: 'OEM pump, includes labour.', quantity: '1', unit_price: '320.00', taxable: true, sort_order: 1 },
    ],
    subtotal: '415.00',
    discount_amount: '0.00',
    discount_type: null,
    discount_value: '0',
    tax_rate: '6.25',
    tax_amount: '25.94',
    total: '440.94',
    amount_paid: '0.00',
    balance_due: '440.94',
    /* The point of this harness: money on the job that this invoice is not showing. */
    job_unapplied_credit: '462.00',
    currency: 'USD',
    due_date: null,
    payment_terms: null,
    created_at: '2026-08-18T14:02:00Z',
    updated_at: '2026-08-19T09:31:00Z',
} as unknown as Parameters<typeof InvoiceDetailPanel>[0]['invoice'];

const okJson = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});
const origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/removal-preview')) {
        return okJson({
            disposition: 'voided',
            payments_total: '0.00',
            payments_count: 0,
            candidate: null,
            preview_version: 'd'.repeat(64),
        });
    }
    if (url.includes('/events')) return okJson({ events: [] });
    if (url.includes('/payments')) return okJson({ payments: [] });
    if (url.includes('/tasks')) return okJson({ tasks: [], total: 0 });
    if (url.includes(`/invoices/${invoice.id}`)) return okJson(invoice);
    if (url.includes('/permissions') || url.includes('/authz') || url.includes('/me')) {
        return okJson({ permissions: ['invoices.view', 'invoices.create', 'invoices.send', 'payments.view', 'payments.collect_offline'] });
    }
    if (url.includes('/api/')) return okJson({ results: [], total: 0, items: [] });
    return origFetch(input, init);
};

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <MemoryRouter>
            <div className="min-h-screen bg-[var(--blanc-bg)] p-6">
                <div className="mx-auto max-w-[960px] rounded-[22px] bg-[var(--blanc-surface-strong)] p-6">
                    <InvoiceDetailPanel
                        invoice={invoice}
                        events={[]}
                        loading={false}
                        onClose={() => {}}
                        onSend={() => {}}
                        onRemoved={() => {}}
                    />
                </div>
            </div>
            <Toaster position="top-center" />
        </MemoryRouter>
    </QueryClientProvider>
);

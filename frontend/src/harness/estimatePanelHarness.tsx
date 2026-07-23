/**
 * Estimate detail panel harness (design review 2026-07-23) — renders the REAL
 * EstimateDetailPanel with mock data so layout/scroll/spacing can be judged
 * without auth/backend. Resize to 375px to check the mobile single-scroll flow.
 *
 * Run:  npx vite (frontend/)  →  /harness.html
 */
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { EstimateDetailPanel } from '../components/estimates/EstimateDetailPanel';
import type { Estimate, EstimateEvent } from '../services/estimatesApi';

const estimate = {
    id: 58,
    company_id: 'demo',
    estimate_number: 'ESTIMATE L-1516-2',
    status: 'approved',
    contact_id: 4532,
    contact_name: 'Tammy Thomas',
    contact_email: 'tammy@example.com',
    contact_phone: '+15085550142',
    lead_id: 1516,
    job_id: null,
    job_number: null,
    summary: 'Double wall oven — not heating. Inspected bake element and thermostat; control board relay failing intermittently. Replacement recommended.',
    items: [
        {
            id: 1, estimate_id: 58, name: 'Diagnostic visit',
            description: 'Full inspection of the appliance, error-code readout, and written findings.',
            quantity: '1', unit_price: '95.00', amount: '95.00', taxable: true, sort_order: 0,
        },
        {
            id: 2, estimate_id: 58, name: 'Control board replacement',
            description: 'OEM control board, includes installation and calibration.',
            quantity: '1', unit_price: '280.00', amount: '280.00', taxable: true, sort_order: 1,
        },
    ],
    subtotal: '375.00',
    discount_type: 'fixed',
    discount_value: '90.00',
    discount_amount: '90.00',
    tax_rate: '6.25',
    tax_amount: '17.81',
    total: '302.81',
    signature_required: true,
    signature_consented_at: null,
    signature_name: null,
    valid_until: null,
    terms: null,
    created_at: '2026-07-23T02:30:00Z',
    updated_at: '2026-07-23T02:31:00Z',
    archived_at: null,
} as unknown as Estimate;

const events = [
    { id: 4, estimate_id: 58, event_type: 'converted_to_invoice', created_at: '2026-07-23T02:33:00Z' },
    { id: 3, estimate_id: 58, event_type: 'approved', created_at: '2026-07-23T02:31:30Z' },
    { id: 2, estimate_id: 58, event_type: 'updated', created_at: '2026-07-23T02:31:00Z' },
    { id: 1, estimate_id: 58, event_type: 'created', created_at: '2026-07-23T02:30:00Z' },
] as unknown as EstimateEvent[];

function App() {
    return (
        <div className="fixed inset-0 bg-[var(--blanc-bg,#F1F1F0)]">
            {/* Mimic the FloatingDetailPanel host: full-height right panel. */}
            <div className="mx-auto h-full max-w-[960px] overflow-hidden bg-[var(--blanc-panel-surface,#fffdf9)] shadow-xl">
                <EstimateDetailPanel
                    estimate={estimate}
                    events={events}
                    loading={false}
                    onClose={() => {}}
                    onSend={() => {}}
                    onApprove={() => {}}
                    onDecline={() => {}}
                    onArchive={() => {}}
                    onRestore={() => {}}
                    onLinkJob={() => {}}
                />
            </div>
        </div>
    );
}

class Boundary extends Component<{ children: ReactNode }, { err: unknown }> {
    state = { err: null as unknown };
    static getDerivedStateFromError(err: unknown) { return { err }; }
    render() {
        if (this.state.err) return <pre style={{ padding: 20, whiteSpace: 'pre-wrap' }}>{String((this.state.err as any)?.stack || this.state.err)}</pre>;
        return this.props.children;
    }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <MemoryRouter>
            <Boundary><App /></Boundary>
        </MemoryRouter>
    </QueryClientProvider>,
);

/**
 * OB-70 removal-confirm harness — renders the REAL InvoiceRemoveDialog against a stubbed
 * preview endpoint, so the three states it can be in are judged as they actually render:
 * nothing paid · money that becomes job credit · money another invoice could take.
 *
 * Run:  npx vite (frontend/)  →  /harness.html   (point harness.html at this file)
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { InvoiceRemoveDialog } from '../components/invoices/InvoiceRemoveDialog';
import { Button } from '../components/ui/button';

type Scene = 'clean' | 'paid' | 'candidate' | 'displayed';

const PREVIEWS: Record<Scene, unknown> = {
    clean: {
        disposition: 'deleted',
        payments_total: '0.00',
        payments_count: 0,
        candidate: null,
        preview_version: 'a'.repeat(64),
    },
    paid: {
        disposition: 'voided',
        payments_total: '462.00',
        payments_count: 1,
        candidate: null,
        preview_version: 'b'.repeat(64),
    },
    candidate: {
        disposition: 'voided',
        payments_total: '462.00',
        payments_count: 2,
        candidate: { id: 77, invoice_number: 'INVOICE 1668-3', balance_due: '462.00' },
        preview_version: 'c'.repeat(64),
    },
    // The staging case: nothing is applied here, but the card reads "Paid · 100%"
    // because this is the job's only invoice and it displays the job's credit.
    displayed: {
        disposition: 'deleted',
        payments_total: '0.00',
        payments_count: 0,
        candidate: null,
        preview_version: 'e'.repeat(64),
    },
};

let scene: Scene = 'candidate';

const okJson = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});
const origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/removal-preview')) return okJson(PREVIEWS[scene]);
    if (url.includes('/remove')) return okJson({ removed: true });
    return origFetch(input, init);
};

function Harness() {
    const [open, setOpen] = useState<Scene | null>(null);
    const start = (next: Scene) => { scene = next; setOpen(next); };

    return (
        <div className="min-h-screen bg-[var(--blanc-bg)] p-8">
            <div className="mx-auto flex max-w-[560px] flex-col gap-3">
                <h1 className="blanc-section-heading">Remove invoice — the three confirms</h1>
                <Button size="action" onClick={() => start('clean')}>Nothing paid</Button>
                <Button size="action" onClick={() => start('paid')}>Paid, no candidate</Button>
                <Button size="action" onClick={() => start('candidate')}>Paid, candidate exists</Button>
                <Button size="action" onClick={() => start('displayed')}>Shows job credit (lone invoice)</Button>
            </div>
            {open ? (
                <InvoiceRemoveDialog
                    invoice={{
                        id: 42,
                        invoice_number: 'INVOICE 1668-2',
                        amount_paid: open === 'displayed' ? '250.00' : '0.00',
                    }}
                    open
                    onOpenChange={next => { if (!next) setOpen(null); }}
                    onRemoved={() => setOpen(null)}
                />
            ) : null}
            <Toaster position="top-center" />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);

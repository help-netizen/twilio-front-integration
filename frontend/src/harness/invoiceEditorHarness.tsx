/**
 * Invoice editor harness — renders the REAL InvoiceEditorDialog with no auth/backend,
 * to judge the MOBILE surface after INVOICE-FULLSCREEN-001.
 *
 * Run:  npx vite (frontend/)  →  /invoice-editor-harness.html   (resize to 375px)
 *
 * What to check at ≤767px:
 *  - the editor covers the WHOLE screen — no bottom-sheet lip, no grab handle, and the
 *    job card is NOT visible above it (that peeking card is what the user ended up
 *    typing into when the sheet slid away);
 *  - the header (title + total) stays pinned, the body scrolls, the footer stays put;
 *  - on a real iOS device: focusing an item title/description keeps the field visible
 *    and shows the native prev/next/done bar — the layer must not move off-screen.
 * Desktop (≥768px) must be unchanged: the right-side panel.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { InvoiceEditorDialog } from '../components/invoices/InvoiceEditorDialog';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
    const [open, setOpen] = useState(true);
    const [saved, setSaved] = useState<string>('(nothing saved yet)');

    return (
        <div style={{ background: 'var(--blanc-bg)', minHeight: '100vh', padding: 20 }}>
            <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--blanc-ink-1)' }}>
                Invoice editor — mobile surface
            </h1>
            <p className="text-[12.5px] mb-4" style={{ color: 'var(--blanc-ink-3)' }}>
                Resize to 375px. The editor must fill the screen, not rise as a sheet.
            </p>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="rounded-xl px-4 py-2 text-sm font-semibold"
                style={{ background: 'var(--blanc-accent)', color: '#fff' }}
            >
                Open invoice editor
            </button>
            <pre className="mt-4 text-[12px]" style={{ color: 'var(--blanc-ink-2)' }}>{saved}</pre>

            <InvoiceEditorDialog
                open={open}
                onOpenChange={setOpen}
                invoice={null}
                defaultJobId={1}
                defaultContext="Job #1682 · Russell"
                onSave={async data => { setSaved(JSON.stringify(data, null, 2)); setOpen(false); }}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
        <MemoryRouter>
            <Harness />
        </MemoryRouter>
    </QueryClientProvider>,
);

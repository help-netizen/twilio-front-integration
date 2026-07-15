/**
 * Financials summary-card dev harness — renders the Job-card ESTIMATED/INVOICED/DUE
 * block BEFORE (Collect-payment button orphaned below) vs AFTER (button moved inside
 * the card as a hairline-separated footer). Uses the REAL <Button> + design tokens.
 *
 * Run:  slot-harness config (npx vite in frontend/)  →  /financials-harness.html
 */
import { createRoot } from 'react-dom/client';
import { CreditCard } from 'lucide-react';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { Button } from '../components/ui/button';

// ── exact copy of JobFinancialsTab's MetricCell ───────────────────────────────
function MetricCell({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }) {
    const valueClass = tone === 'warning' ? 'text-[var(--blanc-warning)]' : 'text-[var(--blanc-ink-1)]';
    return (
        <div className="min-w-0 bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--blanc-ink-3)]">{label}</p>
            <p className={`mt-1 truncate font-mono text-lg font-semibold ${valueClass}`}>{value}</p>
        </div>
    );
}

function Metrics() {
    return (
        <div className="grid grid-cols-3 gap-px">
            <MetricCell label="Estimated" value="$0.00" />
            <MetricCell label="Invoiced" value="$0.00" />
            <MetricCell label="Due" value="$0.00" />
        </div>
    );
}

function CollectBtn() {
    return (
        <Button size="sm">
            <CreditCard className="mr-1 size-4" />Collect payment
        </Button>
    );
}

function App() {
    return (
        <div className="min-h-screen bg-[var(--blanc-panel-surface,#fffdf9)] p-8 text-[var(--blanc-ink-1)]">
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-10 md:grid-cols-2">
                {/* BEFORE — button is a separate block below the card (orphaned) */}
                <div className="space-y-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--blanc-ink-3)]">Before — orphaned</p>
                    <div className="overflow-hidden rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-line)]">
                        <Metrics />
                    </div>
                    <div className="flex justify-end">
                        <CollectBtn />
                    </div>
                </div>

                {/* AFTER — button lives inside the card as a hairline-separated footer */}
                <div className="space-y-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--blanc-ink-3)]">After — inside the block</p>
                    <div className="overflow-hidden rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-line)]">
                        <Metrics />
                        <div className="mt-px flex justify-end bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-2.5">
                            <CollectBtn />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<App />);

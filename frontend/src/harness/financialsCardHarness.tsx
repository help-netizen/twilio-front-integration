/**
 * Financials card + Record-Payment harness (JOB-RECORD-PAYMENT-001) — renders the
 * REAL JobRecordPaymentDialog + the Option-A action footer inside the summary card,
 * so the design/alignment can be judged without auth/backend.
 *
 * Run:  slot-harness config (npx vite in frontend/)  →  /financials-harness.html
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banknote, CreditCard } from 'lucide-react';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { Button } from '../components/ui/button';
import { JobRecordPaymentDialog } from '../components/jobs/JobRecordPaymentDialog';

function MetricCell({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warning' }) {
    const valueClass = tone === 'warning' ? 'text-[var(--blanc-warning)]' : 'text-[var(--blanc-ink-1)]';
    return (
        <div className="min-w-0 bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--blanc-ink-3)]">{label}</p>
            <p className={`mt-1 truncate font-mono text-lg font-semibold ${valueClass}`}>{value}</p>
        </div>
    );
}

function App() {
    const [showRecord, setShowRecord] = useState(false);
    return (
        <div className="min-h-screen bg-[var(--blanc-panel-surface,#fffdf9)] p-8 text-[var(--blanc-ink-1)]">
            <div className="mx-auto max-w-3xl space-y-5">
                {/* Summary card with the Option-A action footer (both buttons visible) */}
                <div className="overflow-hidden rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-line)]">
                    <div className="grid grid-cols-3 gap-px">
                        <MetricCell label="Estimated" value="$480.00" />
                        <MetricCell label="Invoiced" value="$480.00" />
                        <MetricCell label="Due" value="$480.00" tone="warning" />
                    </div>
                    <div className="mt-px grid grid-cols-2 gap-2 bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-3">
                        <Button className="w-full"><CreditCard className="mr-1.5 size-4" />Pay by Card</Button>
                        <Button variant="outline" className="w-full" onClick={() => setShowRecord(true)}>
                            <Banknote className="mr-1.5 size-4" />Record Payment
                        </Button>
                    </div>
                </div>
                {/* Example Payments list (as it renders in the Invoices & payments section) */}
                <div className="rounded-md border border-[var(--blanc-line)] bg-[var(--blanc-panel-surface,#fffdf9)] px-4 py-4">
                    <p className="blanc-eyebrow">Payments</p>
                    <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-4 rounded-md bg-[rgba(25,25,25,0.04)] px-3 py-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">Check</p>
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--blanc-ink-2)]">
                                <span>Jul 15, 2026</span><span aria-hidden="true">·</span><span>Ref 10428</span>
                            </div>
                        </div>
                        <span className="font-mono text-sm font-semibold">$480.00</span>
                    </div>
                </div>
                <p className="text-xs text-[var(--blanc-ink-3)]">Click “Record Payment” to open the real dialog →</p>
            </div>

            <JobRecordPaymentDialog
                open={showRecord}
                onOpenChange={setShowRecord}
                jobId={1443}
                outstanding={480}
                onSuccess={() => setShowRecord(false)}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<App />);

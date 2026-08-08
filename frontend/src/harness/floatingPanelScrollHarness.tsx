/**
 * OVERLAY-SCROLL-CHAIN harness — reproduces the owner's IMG_9780 bug ("scrolling the
 * receipt view scrolls the page BEHIND the overlay") against the REAL FloatingDetailPanel
 * primitive + the REAL design-system CSS (.blanc-floating-panel full-screen mobile cover).
 * No auth / backend.
 *
 * The child mirrors TransactionReview's FIXED root exactly:
 *   min-h-0 flex-1 overflow-y-auto overscroll-contain  → the in-panel scroll owner.
 *
 * What to check (diagnostic banner + window vars):
 *   • BEFORE open: window can scroll (tall background list).
 *   • MOBILE, panel OPEN: body.overflow === 'hidden' (FloatingDetailPanel scrollLock={isMobile})
 *     → the background CANNOT scroll (window.scrollY frozen); the receipt scrolls INSIDE.
 *   • DESKTOP, panel OPEN: body NOT locked (420px drawer, list stays scrollable) — unchanged.
 *
 * Run:  slot-harness launch config (npx vite in frontend/)  →  /floating-panel-scroll-harness.html
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';

// Tall dummy "receipt history" so the panel content overflows a phone viewport.
const HISTORY = Array.from({ length: 24 }, (_, i) => `Receipt sent to customer${i}@example.com on Aug 8, 2026 at 1:${(10 + i)} PM`);

function Diag({ open }: { open: boolean }) {
    const [txt, setTxt] = useState('measuring…');
    useEffect(() => {
        const tick = () => {
            const isMobile = window.matchMedia('(max-width: 767.98px)').matches;
            const scroller = document.querySelector('[data-testid="receipt-scroller"]') as HTMLElement | null;
            setTxt(
                `${isMobile ? 'MOBILE' : 'DESKTOP'} · panel=${open ? 'OPEN' : 'closed'} · ` +
                `body.overflow="${document.body.style.overflow || '(unset)'}" · ` +
                `window.scrollY=${Math.round(window.scrollY)} · ` +
                `receipt.scrollTop=${scroller ? Math.round(scroller.scrollTop) : '—'}`,
            );
        };
        const id = setInterval(tick, 200);
        tick();
        return () => clearInterval(id);
    }, [open]);
    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
            background: '#191919', color: '#fff', font: '12px/1.4 monospace',
            padding: '6px 10px', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
        }}>{txt}</div>
    );
}

function Harness() {
    const [open, setOpen] = useState(false);
    return (
        <div style={{ minHeight: '100vh', background: 'var(--blanc-bg)' }}>
            <Diag open={open} />

            {/* The "page behind" — a tall scrollable list. If the fix regresses, dragging on the
                open panel scrolls THIS underneath (window.scrollY climbs). With the fix it can't. */}
            <div style={{ paddingTop: 40 }}>
                <div style={{ padding: 16 }}>
                    <button
                        onClick={() => setOpen(true)}
                        style={{ padding: '12px 18px', borderRadius: 12, background: 'var(--blanc-accent)', color: '#fff', border: 'none', fontWeight: 600 }}
                    >
                        Open receipt panel
                    </button>
                </div>
                {Array.from({ length: 60 }, (_, i) => (
                    <div key={i} style={{ padding: '16px', borderBottom: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-2)' }}>
                        Background list row {i + 1} — this must NOT move while the panel is open on mobile.
                    </div>
                ))}
            </div>

            <FloatingDetailPanel open={open} onClose={() => setOpen(false)}>
                {/* EXACT mirror of TransactionReview's fixed root className. */}
                <div data-testid="receipt-scroller" className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-6">
                    <div>
                        <p className="font-mono text-3xl font-semibold text-[var(--blanc-ink-1)]">$281.34</p>
                        <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">Payment for #JOB-1617</p>
                        <p className="mt-0.5 text-sm text-[var(--blanc-ink-3)]">Aug 7, 2026 at 8:00 PM</p>
                    </div>
                    <div className="space-y-2">
                        <p className="blanc-eyebrow">Receipt history</p>
                        {HISTORY.map((h, i) => (
                            <p key={i} className="text-sm text-[var(--blanc-ink-2)]">{h}</p>
                        ))}
                    </div>
                    <div className="rounded-2xl bg-[var(--blanc-surface-strong)] border border-[var(--blanc-line)] p-4">
                        <p className="blanc-eyebrow mb-2">Customer email</p>
                        <input
                            className="w-full rounded-xl border-[1.5px] border-transparent bg-[var(--blanc-field)] px-3 py-2 text-sm"
                            defaultValue="ellen.kevokian@outlook.com"
                        />
                        <p className="mt-6 text-sm text-[var(--blanc-ink-3)]">↓ end of receipt — reachable only if the panel owns the scroll ↓</p>
                    </div>
                </div>
            </FloatingDetailPanel>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);

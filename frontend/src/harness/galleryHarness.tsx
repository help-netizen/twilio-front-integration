/**
 * Component gallery — dev-only index of every *-harness.html, each framed at a real
 * device viewport (no fake bezel). It is the fast way to see the component base and
 * the natural target for the design-qa skill: pick a component, pick a viewport,
 * capture, compare — no auth, no backend, no navigating the whole app.
 *
 * Run:  npx vite (frontend/)  →  /gallery.html
 * Zero-maintenance: auto-discovers sibling harness entries via import.meta.glob, so a
 * new `*-harness.html` shows up here on its own.
 */
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/design-system.css';

// Every sibling `<name>-harness.html`. Vite resolves each to its served URL. `gallery.html`
// and the legacy alias `harness.html` don't match `*-harness.html`, so they're excluded.
const entries = import.meta.glob('/*-harness.html', {
    query: '?url', import: 'default', eager: true,
}) as Record<string, string>;

const DEVICES = {
    Mobile: { w: 375, h: 812 },
    Tablet: { w: 768, h: 1024 },
    Desktop: { w: 1280, h: 800 },
} as const;
type Device = keyof typeof DEVICES;

const label = (path: string) =>
    path.replace(/^\//, '').replace(/-harness\.html$/, '').replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

function Gallery() {
    const list = useMemo(
        () => Object.keys(entries).sort((a, b) => a.localeCompare(b)),
        [],
    );
    const [sel, setSel] = useState<string>(list[0] ?? '');
    const [device, setDevice] = useState<Device>('Mobile');
    const { w, h } = DEVICES[device];

    if (!list.length) {
        return (
            <div style={{ padding: 40, fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: 'var(--blanc-ink-1)' }}>
                No <code>*-harness.html</code> entries found in <code>frontend/</code>.
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: 'IBM Plex Sans, system-ui, sans-serif', background: 'var(--blanc-bg)', color: 'var(--blanc-ink-1)' }}>
            {/* Sidebar — component list */}
            <aside style={{ width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
                <div style={{ padding: '16px 18px 10px' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>Component Gallery</div>
                    <div style={{ fontSize: 12.5, color: 'var(--blanc-ink-3)', marginTop: 2 }}>{list.length} harnesses · dev only</div>
                </div>
                <nav style={{ overflowY: 'auto', padding: '4px 8px 16px' }}>
                    {list.map(p => {
                        const active = p === sel;
                        return (
                            <button
                                key={p}
                                type="button"
                                onClick={() => setSel(p)}
                                style={{
                                    display: 'block', width: '100%', textAlign: 'left', marginBottom: 2,
                                    padding: '8px 10px', borderRadius: 10, border: 0, cursor: 'pointer',
                                    fontSize: 13.5, fontWeight: active ? 600 : 500,
                                    background: active ? 'var(--blanc-accent-soft)' : 'transparent',
                                    color: active ? 'var(--blanc-accent)' : 'var(--blanc-ink-1)',
                                }}
                            >
                                {label(p)}
                            </button>
                        );
                    })}
                </nav>
            </aside>

            {/* Stage */}
            <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderBottom: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong)' }}>
                    <div style={{ display: 'inline-flex', gap: 2, background: 'var(--blanc-field)', borderRadius: 10, padding: 3 }}>
                        {(Object.keys(DEVICES) as Device[]).map(d => {
                            const active = d === device;
                            return (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => setDevice(d)}
                                    style={{
                                        padding: '6px 14px', borderRadius: 8, border: 0, cursor: 'pointer',
                                        fontSize: 13, fontWeight: 600,
                                        background: active ? 'var(--blanc-surface-strong)' : 'transparent',
                                        color: active ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                                        boxShadow: active ? '0 1px 2px rgba(0,0,0,.10)' : 'none',
                                    }}
                                >
                                    {d}
                                </button>
                            );
                        })}
                    </div>
                    <span style={{ fontSize: 12.5, color: 'var(--blanc-ink-3)', fontVariantNumeric: 'tabular-nums' }}>{w} × {h}</span>
                    <a href={sel} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: 'var(--blanc-accent)', textDecoration: 'none' }}>
                        Open standalone ↗
                    </a>
                </div>

                <div style={{ flex: 1, overflow: 'auto', display: 'grid', placeItems: 'start center', padding: 24, background: 'var(--blanc-bg-deep)' }}>
                    <div style={{ width: w, maxWidth: '100%' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--blanc-ink-3)', marginBottom: 8 }}>{label(sel)}</div>
                        <iframe
                            key={sel + device}
                            src={sel}
                            title={label(sel)}
                            style={{ width: w, height: h, maxWidth: '100%', border: '1px solid var(--blanc-line-strong)', borderRadius: 16, background: 'var(--blanc-surface-strong)', boxShadow: '0 6px 24px rgba(0,0,0,.06)' }}
                        />
                    </div>
                </div>
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Gallery />);

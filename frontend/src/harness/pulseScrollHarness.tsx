/**
 * OB-32 / OB-40 harness — reproduces the mobile Pulse CONTENT-mode scroll chain
 * with the REAL shell/page CSS (AppLayout.css + design-system.css + PulsePage.css):
 * .app-layout > .app-main > .blanc-page-wrapper >
 * .pulse-layout[data-mobile-panel="content"] > .pulse-right-column
 * (pinned bar + timeline + composer card). No auth/backend.
 *
 * Query params (default = the owner's IMG_9467 case):
 *   ?items=N     timeline bubbles (default 5 → under-fills a tall phone)
 *   ?banner=on   add the autonomous banner + has-autonomous-banner class (default off)
 *
 * Run:  slot-harness config (npx vite in frontend/)  →  /pulse-scroll-harness.html
 * The DIAGNOSTIC banner reports app-main overscroll AND the gap (px of bare canvas)
 * between the composer's bottom and the fixed nav's top — that gap is the grey strip.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import '../components/layout/AppLayout.css';
import '../pages/PulsePage.css';

const params = new URLSearchParams(location.search);
const ITEMS = Number(params.get('items') ?? 5);
const BANNER = params.get('banner') === 'on';

function Harness() {
    const [report, setReport] = useState('measuring…');

    useEffect(() => {
        const id = setTimeout(() => {
            const appMain = document.querySelector('.app-main') as HTMLElement;
            const column = document.querySelector('.pulse-right-column') as HTMLElement;
            const composer = document.querySelector('[data-testid="composer"]') as HTMLElement;
            const nav = document.querySelector('.app-bottom-nav') as HTMLElement;
            const mainScrollable = appMain.scrollHeight - appMain.clientHeight;
            const columnScrollable = column.scrollHeight - column.clientHeight;
            const mainOverflow = getComputedStyle(appMain).overflowY;
            const gap = Math.round(nav.getBoundingClientRect().top - composer.getBoundingClientRect().bottom);
            setReport(
                `main.overflowY=${mainOverflow} scrollable=${mainScrollable}px | ` +
                `column.scrollable=${columnScrollable}px | ` +
                `GAP composer→nav = ${gap}px ${gap > 20 ? '❌ GREY STRIP' : '✅ tight'}`
            );
        }, 150);
        return () => clearTimeout(id);
    }, []);

    return (
        <div className={`app-layout${BANNER ? ' has-autonomous-banner' : ''}`} style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
            <div
                style={{
                    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
                    background: '#111', color: '#0f0', font: '10px/1.35 monospace', padding: '4px 8px',
                }}
                data-testid="report"
            >
                {report}
            </div>
            <main className="app-main">
                <div className="blanc-page-wrapper" style={{ display: 'flex', flexDirection: 'column' }}>
                    <div className="pulse-layout" data-mobile-panel="content">
                        <div className="pulse-right-column">
                            <div className="pulse-card" style={{ padding: 14 }}>
                                <strong>Elfrida Trifoni</strong>
                                <div style={{ color: 'var(--blanc-ink-2)', fontSize: 13 }}>LEAD #1476 · COD Service</div>
                            </div>
                            <div>
                                {Array.from({ length: ITEMS }, (_, i) => (
                                    <div key={i} style={{ padding: '5px 20px' }}>
                                        <div
                                            style={{
                                                background: 'var(--blanc-surface-strong)', borderRadius: 14,
                                                padding: '10px 14px', maxWidth: 300, fontSize: 14,
                                                marginLeft: i % 2 ? 'auto' : 0,
                                            }}
                                        >
                                            Message bubble #{i + 1}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="pulse-card pulse-reply-dock" data-testid="composer" style={{ padding: 14 }}>
                                <textarea
                                    style={{
                                        width: '100%', minHeight: 90, border: '1px solid var(--blanc-line)',
                                        borderRadius: 12, padding: 10, font: 'inherit',
                                    }}
                                    defaultValue="Type your message..."
                                />
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                                    <button style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid var(--blanc-line)', background: 'transparent' }}>Quick</button>
                                    <button style={{ padding: '8px 16px', borderRadius: 10, border: 0, background: 'var(--blanc-accent)', color: '#fff' }}>Send</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
            {BANNER && (
                <div className="autonomous-banner" style={{ position: 'fixed', left: 0, right: 0, background: '#F6EFE3', color: '#8a6d1d', textAlign: 'center', fontSize: 13, padding: '10px 12px', zIndex: 80 }}>
                    Autonomous mode is ON
                </div>
            )}
            <nav className="app-bottom-nav" style={{ display: 'flex' }}>
                {['Pulse', 'Leads', 'Jobs', 'Schedule', 'Tasks'].map(label => (
                    <div key={label} className="app-bottom-nav-item">{label}</div>
                ))}
            </nav>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);

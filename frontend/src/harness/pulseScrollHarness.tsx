/**
 * OB-32 harness — reproduces the mobile Pulse CONTENT-mode scroll chain with
 * the REAL shell/page CSS (AppLayout.css + design-system.css + PulsePage.css):
 * .app-layout.has-autonomous-banner > .app-main > .blanc-page-wrapper >
 * .pulse-layout[data-mobile-panel="content"] > .pulse-right-column
 * (pinned bar + tall timeline + composer card). No auth/backend.
 *
 * Run:  slot-harness config (npx vite in frontend/)  →  /pulse-scroll-harness.html
 * Expectation (OB-32 fix): `.app-main` must NOT be scrollable — swiping past
 * the composer may not reveal the empty gradient strip; only
 * `.pulse-right-column` scrolls. The DIAGNOSTIC banner reports both.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import '../components/layout/AppLayout.css';
import '../pages/PulsePage.css';

function Harness() {
    const [report, setReport] = useState('measuring…');

    useEffect(() => {
        const id = setTimeout(() => {
            const appMain = document.querySelector('.app-main') as HTMLElement;
            const column = document.querySelector('.pulse-right-column') as HTMLElement;
            const mainScrollable = appMain.scrollHeight - appMain.clientHeight;
            const columnScrollable = column.scrollHeight - column.clientHeight;
            const mainOverflow = getComputedStyle(appMain).overflowY;
            setReport(
                `app-main: overflowY=${mainOverflow}, scrollable=${mainScrollable}px ` +
                `(${mainOverflow === 'hidden' || mainScrollable <= 0 ? 'OK — page cannot overscroll' : 'BUG — page overscrolls'}); ` +
                `pulse-right-column: scrollable=${columnScrollable}px (${columnScrollable > 0 ? 'OK — timeline scrolls' : 'unexpected: no inner scroll'})`
            );
        }, 100);
        return () => clearTimeout(id);
    }, []);

    return (
        <div className="app-layout has-autonomous-banner" style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
            <div
                style={{
                    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200,
                    background: '#111', color: '#0f0', font: '11px/1.4 monospace', padding: '4px 8px',
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
                                <strong>Christina M.</strong>
                                <div style={{ color: 'var(--blanc-ink-2)', fontSize: 13 }}>83 Hobart St, Danvers, MA</div>
                            </div>
                            <div>
                                {Array.from({ length: 24 }, (_, i) => (
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
                            <div className="pulse-card" style={{ padding: 14 }}>
                                <textarea
                                    style={{
                                        width: '100%', minHeight: 90, border: '1px solid var(--blanc-line)',
                                        borderRadius: 12, padding: 10, font: 'inherit',
                                    }}
                                    defaultValue="Hello Christina, thank you for letting us know."
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
            <div className="autonomous-banner" style={{ position: 'fixed', left: 0, right: 0, background: '#F6EFE3', color: '#8a6d1d', textAlign: 'center', fontSize: 13, padding: '10px 12px', zIndex: 80 }}>
                Autonomous mode is ON
            </div>
            <nav className="app-bottom-nav" style={{ display: 'flex' }}>
                {['Pulse', 'Leads', 'Jobs', 'Schedule', 'Tasks'].map(label => (
                    <div key={label} className="app-bottom-nav-item">{label}</div>
                ))}
            </nav>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);

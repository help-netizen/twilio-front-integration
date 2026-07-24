/**
 * Marketplace app-logo harness — the same logo/monogram logic as
 * IntegrationsPage.MarketplaceAppLogo: uploaded logo when present, else a
 * first-letter monogram; a broken image falls back to the monogram too.
 * Run: slot-harness (npx vite in frontend/) → /app-logo-harness.html
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';

function AppLogo({ name, logo_url }: { name: string; logo_url: string | null }) {
    const [imgOk, setImgOk] = useState(true);
    const letter = (name?.trim()?.[0] ?? '?').toUpperCase();
    if (logo_url && imgOk) {
        return (
            <img src={logo_url} alt="" onError={() => setImgOk(false)}
                className="h-11 w-11 shrink-0 rounded-xl object-contain bg-[var(--blanc-surface-muted)]" />
        );
    }
    return (
        <div aria-hidden style={{ fontFamily: 'var(--blanc-font-heading)' }}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--blanc-field)] text-lg font-bold text-[var(--blanc-ink-2)]">
            {letter}
        </div>
    );
}

const GPT_LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="14" fill="#10a37f"/><text x="40" y="52" font-family="sans-serif" font-size="34" fill="#fff" text-anchor="middle">G</text></svg>')}`;

const apps = [
    { name: 'ChatGPT CRM Connector', provider: 'Albusto', logo_url: null },
    { name: 'Zenbooker', provider: 'Zenbooker', logo_url: null },
    { name: 'Rate Me', provider: 'Albusto', logo_url: null },
    { name: 'Stripe Payments', provider: 'Stripe', logo_url: GPT_LOGO },
    { name: 'Inspector', provider: 'Albusto', logo_url: null },
    { name: 'Broken logo URL', provider: 'Test', logo_url: 'https://example.invalid/nope.png' },
];

function Harness() {
    return (
        <div className="min-h-screen bg-[var(--blanc-bg)] p-8">
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' }}>
                {apps.map(a => (
                    <div key={a.name} className="flex min-h-[120px] flex-col rounded-xl border border-[var(--blanc-line)] bg-[var(--blanc-surface-strong)] p-5">
                        <div className="flex items-start gap-3">
                            <AppLogo name={a.name} logo_url={a.logo_url} />
                            <div className="min-w-0">
                                <h3 className="truncate text-lg font-semibold text-[var(--blanc-ink-1)]">{a.name}</h3>
                                <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">{a.provider}</p>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);

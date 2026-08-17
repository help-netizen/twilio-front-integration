/**
 * Marketplace redesign harness (MARKETPLACE-RATINGS-001) — the REAL grid + detail
 * panel with a fetch stub for /api/marketplace/apps + /reviews + rating submit.
 * Run: slot-harness (npx vite in frontend/) → /marketplace-harness.html
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { Button } from '../components/ui/button';
import { MarketplaceGrid } from '../components/settings/marketplace/MarketplaceGrid';
import { MarketplaceAppDetail } from '../components/settings/marketplace/MarketplaceAppDetail';
import type { MarketplaceApp } from '../services/marketplaceApi';

function app(over: Partial<MarketplaceApp> & Pick<MarketplaceApp, 'app_key' | 'name' | 'category'>): MarketplaceApp {
    return {
        id: Math.floor(Math.random() * 1e6), provider_name: 'Albusto', app_type: 'internal',
        short_description: 'A short one-line description of what this app does for you.',
        long_description: 'A fuller paragraph describing exactly what the app does, how it uses your data, and that it can be turned off anytime.',
        logo_url: null, docs_url: null, support_email: null, privacy_url: null,
        requested_scopes: [], access_summary: ['Read jobs, leads & contacts', 'Create & edit records'],
        provisioning_mode: 'manual', status: 'published', metadata: { pricing: { paid: false, label: 'Free', text: 'Free — included with your Albusto plan.' } },
        installation: null, avg_rating: null, rating_count: 0, ...over,
    };
}

const APPS: MarketplaceApp[] = [
    app({ app_key: 'chatgpt-crm-mcp', name: 'Avatars', category: 'ai', short_description: 'Give each teammate a personal AI copy that works in Albusto with their own access.', avg_rating: 4.8, rating_count: 64, installation: { id: 1, status: 'connected', installed_at: null, provisioning_error: null, last_used_at: null } }),
    app({ app_key: 'rate-me', name: 'Rate Me', category: 'customer_experience', avg_rating: 4.9, rating_count: 156, installation: { id: 2, status: 'connected', installed_at: null, provisioning_error: null, last_used_at: null } }),
    app({ app_key: 'stripe-payments', name: 'Stripe Payments', provider_name: 'Stripe', category: 'payments', avg_rating: 4.9, rating_count: 210, metadata: { pricing: { paid: false, label: 'Free', text: 'Free to install — standard Stripe processing fees apply.' } } }),
    app({ app_key: 'yelp-leads', name: 'Yelp Leads', category: 'lead_generation', avg_rating: 4.5, rating_count: 11 }),
    app({ app_key: 'lead-generator', name: 'Website Leads', category: 'lead_generation', avg_rating: 4.6, rating_count: 78, installation: { id: 3, status: 'connected', installed_at: null, provisioning_error: null, last_used_at: null } }),
    app({ app_key: 'smart-slot-engine', name: 'Smart Scheduling', category: 'scheduling', avg_rating: 4.7, rating_count: 92 }),
    app({ app_key: 'inspector', name: 'Job Watchdog', category: 'ai', avg_rating: 0, rating_count: 0 }),
];

const REVIEWS = [
    { id: 1, app_key: 'chatgpt-crm-mcp', stars: 5, comment: 'Set it up in ten minutes and it just works. The team uses it daily.', status: 'posted', reviewer_first_name: 'Marcus', is_mine: false, created_at: '', updated_at: '' },
    { id: 2, app_key: 'chatgpt-crm-mcp', stars: 4, comment: 'Solid — took a day for the crew to get comfortable, then adoption took off.', status: 'posted', reviewer_first_name: 'Dean', is_mine: false, created_at: '', updated_at: '' },
    { id: 3, app_key: 'chatgpt-crm-mcp', stars: 5, comment: '', status: 'posted', reviewer_first_name: 'Priya', is_mine: false, created_at: '', updated_at: '' },
];

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/marketplace/apps')) return ok({ success: true, apps: APPS });
    const rev = url.match(/\/api\/marketplace\/apps\/([^/]+)\/reviews$/);
    if (rev) return ok({ success: true, app_key: rev[1], reviews: REVIEWS.filter(r => r.app_key === rev[1]) });
    if (/\/api\/marketplace\/apps\/[^/]+\/rating$/.test(url) && (init?.method || 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (typeof body.comment === 'string' && /https?:\/\/|www\.|@\w/.test(body.comment))
            return new Response(JSON.stringify({ success: false, code: 'REVIEW_LINKS_NOT_ALLOWED', message: 'Links not allowed' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
        return ok({ success: true, status: 'posted', review: { id: 99, app_key: 'x', stars: body.stars, comment: body.comment ?? null, status: 'posted', moderation_reason: null, moderation_source: null, created_at: '', updated_at: '' } });
    }
    return realFetch(input, init);
};

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
    const [key, setKey] = useState<string | null>(null);
    const detail = key ? APPS.find(a => a.app_key === key) ?? null : null;
    return (
        <div className="min-h-screen bg-[var(--blanc-bg)] px-6 py-8">
            <div className="mx-auto max-w-[1140px]">
                <div className="blanc-eyebrow">Settings · Integrations</div>
                <h1 className="mb-6 text-[30px] font-bold tracking-[-.02em] text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>Marketplace</h1>
                <MarketplaceGrid apps={APPS} onOpen={a => setKey(a.app_key)} />
            </div>
            <MarketplaceAppDetail
                app={detail} open={!!detail} onClose={() => setKey(null)}
                actions={detail ? <Button size="sm">{detail.installation?.status === 'connected' ? 'Manage' : 'Enable'}</Button> : null}
            />
            <Toaster position="bottom-right" />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={qc}><Harness /></QueryClientProvider>,
);

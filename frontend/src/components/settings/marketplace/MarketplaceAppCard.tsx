import type { MarketplaceApp } from '../../../services/marketplaceApi';
import {
    appGradient, appMonogram, appPricing, categoryLabel, isAppConnected, Stars,
} from './marketplaceUi';

/**
 * A rich, clickable marketplace card (MARKETPLACE-RATINGS-001 redesign). The whole
 * card opens the app detail panel, where the real per-app actions live — so the
 * card stays purely presentational and carries no install branching.
 */
export function MarketplaceAppCard({ app, onOpen }: { app: MarketplaceApp; onOpen: (app: MarketplaceApp) => void }) {
    const connected = isAppConnected(app);
    const pricing = appPricing(app);
    const isNew = app.rating_count > 0 && app.rating_count < 15;

    return (
        <button
            type="button"
            onClick={() => onOpen(app)}
            className="group flex min-h-[196px] w-full flex-col rounded-2xl bg-[var(--blanc-surface-strong)] p-[18px] text-left transition-[transform,box-shadow] duration-150 hover:-translate-y-[3px]"
            style={{ boxShadow: '0 1px 2px rgba(25,25,25,.04)' }}
            onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 12px 30px rgba(25,25,25,.10)')}
            onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 1px 2px rgba(25,25,25,.04)')}
        >
            <div className="flex items-start gap-3">
                <div
                    className="grid h-[50px] w-[50px] shrink-0 place-items-center rounded-[14px] text-[20px] font-bold text-white"
                    style={{ background: appGradient(app), fontFamily: 'var(--blanc-font-heading)', boxShadow: '0 4px 10px rgba(25,25,25,.12)' }}
                    aria-hidden
                >
                    {app.logo_url
                        ? <img src={app.logo_url} alt="" className="h-full w-full rounded-[14px] object-contain" onError={e => (e.currentTarget.style.display = 'none')} />
                        : appMonogram(app.name)}
                </div>
                <div className="min-w-0 flex-1">
                    <h4 className="truncate text-[16px] font-bold tracking-[-.01em] text-[var(--blanc-ink-1)]">{app.name}</h4>
                    <div className="mt-0.5 truncate text-[13px] text-[var(--blanc-ink-3)]">
                        {app.provider_name} · {categoryLabel(app.category)}
                    </div>
                </div>
                <span
                    className={`shrink-0 self-start rounded-full px-[9px] py-1 text-[11px] font-bold ${
                        pricing.paid ? 'text-[var(--blanc-accent-ink,#5b2bb0)]' : 'text-[#1b6b4d]'
                    }`}
                    style={{ background: pricing.paid ? '#efe6ff' : '#e2f2ea' }}
                >
                    {pricing.paid ? 'Paid' : 'Free'}
                </span>
            </div>

            <div className="mt-3 flex items-center gap-1.5 text-[13px]">
                {app.rating_count > 0 ? (
                    <>
                        <Stars value={app.avg_rating ?? 0} />
                        <b className="font-bold text-[var(--blanc-ink-1)]">{(app.avg_rating ?? 0).toFixed(1)}</b>
                        {isNew
                            ? <span className="text-[12px] font-bold text-[var(--blanc-task,#1b8b63)]">· New</span>
                            : <span className="text-[var(--blanc-ink-3)]">· {app.rating_count}</span>}
                    </>
                ) : (
                    <span className="text-[13px] text-[var(--blanc-ink-3)]">No ratings yet</span>
                )}
            </div>

            <p className="mt-2 line-clamp-2 min-h-[38px] text-[14px] text-[var(--blanc-ink-2)]">{app.short_description}</p>

            <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--blanc-line)] pt-3.5">
                <span className={`text-[13px] font-semibold ${connected ? 'text-[var(--blanc-task,#1b8b63)]' : 'text-[var(--blanc-ink-3)]'}`}>
                    {connected ? '● Enabled' : app.installation?.status === 'provisioning_failed' ? 'Needs attention' : 'Not installed'}
                </span>
                <span className="text-[13px] font-semibold text-[var(--blanc-accent)] group-hover:underline">
                    {connected ? 'Manage' : 'Details'} ›
                </span>
            </div>
        </button>
    );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FloatingDetailPanel } from '../../ui/FloatingDetailPanel';
import { Button } from '../../ui/button';
import {
    deleteMyAppRating, fetchAppReviews, MarketplaceRatingError, submitAppRating,
    type AppReview, type MarketplaceApp,
} from '../../../services/marketplaceApi';
import {
    appGradient, appMonogram, appPricing, categoryLabel, GOLD, GOLD_EMPTY, Stars,
} from './marketplaceUi';

/** Small gold star-picker for writing a review. */
function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const [hover, setHover] = useState(0);
    const shown = hover || value;
    return (
        <div role="radiogroup" aria-label="Your rating" className="flex gap-1" onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map(i => (
                <button
                    key={i} type="button" aria-label={`${i} star${i > 1 ? 's' : ''}`} aria-checked={value === i} role="radio"
                    onMouseEnter={() => setHover(i)} onClick={() => onChange(i)}
                    className="text-[26px] leading-none transition-transform hover:scale-110"
                    style={{ color: i <= shown ? GOLD : GOLD_EMPTY }}
                >★</button>
            ))}
        </div>
    );
}

function ReviewRow({ app, r }: { app: MarketplaceApp; r: AppReview }) {
    return (
        <div className="flex gap-3 border-t border-[var(--blanc-line)] py-4 first:border-t-0">
            <div className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full text-sm font-bold text-white"
                style={{ background: appGradient(app), fontFamily: 'var(--blanc-font-heading)' }} aria-hidden>
                {(r.reviewer_first_name?.[0] || '?').toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[14px] font-bold text-[var(--blanc-ink-1)]">{r.reviewer_first_name || 'Someone'}</span>
                    {r.is_mine && <span className="text-[11px] font-semibold text-[var(--blanc-ink-3)]">· you</span>}
                    {r.is_mine && r.status === 'pending' && (
                        <span className="rounded-full bg-[rgba(178,106,29,0.12)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--blanc-warning,#b26a1d)]">Under review</span>
                    )}
                    {r.is_mine && r.status === 'rejected' && (
                        <span className="rounded-full bg-[rgba(240,80,63,0.12)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--blanc-danger,#F0503F)]">Not published</span>
                    )}
                </div>
                <div className="mt-0.5"><Stars value={r.stars} size={13} /></div>
                {r.comment && <p className="mt-1.5 text-[13.5px] text-[var(--blanc-ink-2)]">{r.comment}</p>}
            </div>
        </div>
    );
}

interface Props {
    app: MarketplaceApp | null;
    open: boolean;
    onClose: () => void;
    /** Per-app primary action(s) (install/manage/configure), owned by IntegrationsPage. */
    actions?: ReactNode;
}

export function MarketplaceAppDetail({ app, open, onClose, actions }: Props) {
    const qc = useQueryClient();
    const appKey = app?.app_key ?? '';
    const [stars, setStars] = useState(0);
    const [comment, setComment] = useState('');
    const [linkError, setLinkError] = useState(false);

    const reviewsQ = useQuery({
        queryKey: ['app-reviews', appKey],
        queryFn: () => fetchAppReviews(appKey),
        enabled: open && !!appKey,
    });
    const reviews = reviewsQ.data ?? [];
    const mine = useMemo(() => reviews.find(r => r.is_mine) ?? null, [reviews]);

    // Seed the form from the viewer's existing review whenever it (or the app) changes.
    useEffect(() => {
        setStars(mine?.stars ?? 0);
        setComment(mine?.comment ?? '');
        setLinkError(false);
    }, [mine, appKey]);

    const posted = reviews.filter(r => r.status === 'posted');
    const histo = useMemo(() => {
        const c = [0, 0, 0, 0, 0]; // index 0 = 1 star … 4 = 5 star
        posted.forEach(r => { if (r.stars >= 1 && r.stars <= 5) c[r.stars - 1] += 1; });
        const total = posted.length || 1;
        return [5, 4, 3, 2, 1].map(s => ({ s, pct: Math.round((c[s - 1] / total) * 100) }));
    }, [posted]);

    const submit = useMutation({
        mutationFn: () => submitAppRating(appKey, { stars, comment: comment.trim() || undefined }),
        onSuccess: (res) => {
            qc.invalidateQueries({ queryKey: ['app-reviews', appKey] });
            qc.invalidateQueries({ queryKey: ['marketplace-apps'] });
            toast.success(res.status === 'posted' ? 'Review posted' : 'Thanks — your review is in for a quick check');
        },
        onError: (e: unknown) => {
            if (e instanceof MarketplaceRatingError && e.code === 'REVIEW_LINKS_NOT_ALLOWED') { setLinkError(true); return; }
            toast.error(e instanceof Error ? e.message : 'Could not submit your review');
        },
    });
    const del = useMutation({
        mutationFn: () => deleteMyAppRating(appKey),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['app-reviews', appKey] });
            qc.invalidateQueries({ queryKey: ['marketplace-apps'] });
            setStars(0); setComment(''); toast.success('Your review was removed');
        },
        onError: (e: Error) => toast.error(e.message || 'Could not remove your review'),
    });

    if (!app) return null;
    const pricing = appPricing(app);
    const access = app.access_summary?.length ? app.access_summary : app.requested_scopes;
    const badges: ReactNode[] = [
        <span key="cat" className="rounded-full px-[9px] py-1 text-[11px] font-bold"
            style={{ background: 'color-mix(in srgb, var(--blanc-accent) 12%, transparent)', color: 'var(--blanc-accent-ink,#5b2bb0)' }}>
            {categoryLabel(app.category)}
        </span>,
    ];
    if (app.app_key === 'chatgpt-crm-mcp') badges.push(<span key="f" className="rounded-full bg-[var(--blanc-accent-soft)] px-[9px] py-1 text-[11px] font-bold text-[var(--blanc-accent-ink,#5b2bb0)]">★ Featured</span>);
    else if (app.rating_count >= 100) badges.push(<span key="p" className="rounded-full px-[9px] py-1 text-[11px] font-bold" style={{ background: '#fdeacb', color: '#8a5a12' }}>Popular</span>);
    else if (app.rating_count > 0 && app.rating_count < 15) badges.push(<span key="n" className="rounded-full px-[9px] py-1 text-[11px] font-bold" style={{ background: '#d8f0e5', color: '#1b6b4d' }}>New</span>);

    return (
        <FloatingDetailPanel open={open} onClose={onClose} wide>
            <div className="max-h-full overflow-y-auto px-7 py-7 md:px-8">
                <div className="mx-auto w-full max-w-[640px]">
                    {/* hero */}
                    <div className="flex items-start gap-4">
                        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-[26px] font-bold text-white"
                            style={{ background: appGradient(app), fontFamily: 'var(--blanc-font-heading)' }} aria-hidden>
                            {app.logo_url ? <img src={app.logo_url} alt="" className="h-full w-full rounded-2xl object-contain" onError={e => (e.currentTarget.style.display = 'none')} /> : appMonogram(app.name)}
                        </div>
                        <div className="min-w-0 flex-1 pr-8">
                            <h2 className="text-[23px] font-bold leading-tight tracking-[-.01em] text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{app.name}</h2>
                            <div className="mt-1 text-[13.5px] text-[var(--blanc-ink-3)]">by {app.provider_name}</div>
                            <div className="mt-2.5 flex flex-wrap gap-1.5">{badges}</div>
                        </div>
                    </div>

                    {/* rating summary — flush-left */}
                    <div className="mt-4 flex items-center gap-2.5 border-t border-[var(--blanc-line)] pt-4">
                        {app.rating_count > 0 ? (
                            <>
                                <span className="text-[30px] font-bold leading-none text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{(app.avg_rating ?? 0).toFixed(1)}</span>
                                <div>
                                    <Stars value={app.avg_rating ?? 0} size={16} />
                                    <div className="text-[12.5px] text-[var(--blanc-ink-3)]">{app.rating_count} rating{app.rating_count > 1 ? 's' : ''}</div>
                                </div>
                            </>
                        ) : <span className="text-[13.5px] text-[var(--blanc-ink-3)]">No ratings yet — be the first.</span>}
                    </div>

                    {/* primary action(s) */}
                    {actions && <div className="mt-4 flex flex-wrap items-center gap-2.5">{actions}</div>}

                    {/* what it does */}
                    <div className="blanc-eyebrow mt-7">What it does</div>
                    <p className="mt-2.5 text-[14.5px] text-[var(--blanc-ink-2)]">{app.long_description || app.short_description}</p>
                    {access?.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {access.map(a => <span key={a} className="rounded-full bg-[var(--blanc-field)] px-[11px] py-[5px] text-[12px] text-[var(--blanc-ink-2)]">{a}</span>)}
                        </div>
                    )}

                    {/* billing */}
                    <div className="blanc-eyebrow mt-7">Billing</div>
                    <div className="mt-2.5 flex items-start gap-3">
                        <span className={`shrink-0 rounded-full px-[9px] py-1 text-[11px] font-bold ${pricing.paid ? 'text-[var(--blanc-accent-ink,#5b2bb0)]' : 'text-[#1b6b4d]'}`}
                            style={{ background: pricing.paid ? '#efe6ff' : '#e2f2ea' }}>{pricing.paid ? 'Paid' : 'Free'}</span>
                        <p className="text-[14.5px] text-[var(--blanc-ink-2)]">{pricing.text}</p>
                    </div>

                    {/* ratings & reviews */}
                    <div className="blanc-eyebrow mt-7">Ratings &amp; reviews</div>
                    <div className="mt-2.5 flex items-center gap-6 rounded-2xl bg-[var(--blanc-surface-muted)] p-5">
                        <div className="text-center">
                            <div className="text-[44px] font-bold leading-none text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{(app.avg_rating ?? 0).toFixed(1)}</div>
                            <div className="mt-1"><Stars value={app.avg_rating ?? 0} size={15} /></div>
                            <div className="mt-1 text-[12px] text-[var(--blanc-ink-3)]">{app.rating_count} rating{app.rating_count === 1 ? '' : 's'}</div>
                        </div>
                        <div className="flex-1 space-y-1.5">
                            {histo.map(({ s, pct }) => (
                                <div key={s} className="flex items-center gap-2.5 text-[12px] text-[var(--blanc-ink-3)]">
                                    <span className="w-2 tabular-nums">{s}</span>
                                    <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-[#e6e6e3]"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: GOLD }} /></div>
                                    <span className="w-8 text-right tabular-nums">{pct}%</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {posted.length === 0 && !mine && <p className="mt-4 text-[13.5px] text-[var(--blanc-ink-3)]">No written reviews yet.</p>}
                    <div className="mt-2">
                        {reviews.slice().sort((a, b) => (a.is_mine === b.is_mine ? 0 : a.is_mine ? -1 : 1)).map(r => <ReviewRow key={r.id} app={app} r={r} />)}
                    </div>

                    {/* write a review */}
                    <div className="blanc-eyebrow mt-7">{mine ? 'Your review' : 'Rate this app'}</div>
                    <div className="mt-2.5 rounded-2xl bg-[var(--blanc-surface-muted)] p-5">
                        <StarPicker value={stars} onChange={setStars} />
                        <textarea
                            value={comment}
                            onChange={e => { setComment(e.target.value); if (linkError) setLinkError(false); }}
                            placeholder="Share what worked (or didn’t) for your team…"
                            maxLength={1000}
                            className="mt-3 min-h-[76px] w-full resize-y rounded-xl border bg-white px-3.5 py-3 text-[14px] text-[var(--blanc-ink-1)] outline-none focus:border-[var(--blanc-accent)]"
                            style={{ borderColor: linkError ? 'var(--blanc-danger,#F0503F)' : 'var(--blanc-line)' }}
                        />
                        {linkError && <p className="mt-2 text-[12.5px] text-[var(--blanc-danger,#F0503F)]">Links and @handles aren’t allowed in reviews — please remove them.</p>}
                        <div className="mt-3 flex items-center gap-2.5">
                            <Button type="button" disabled={stars < 1 || submit.isPending} onClick={() => submit.mutate()}>
                                {submit.isPending ? 'Sending…' : mine ? 'Update review' : 'Post review'}
                            </Button>
                            {mine && (
                                <Button type="button" variant="ghost" disabled={del.isPending}
                                    className="text-[var(--blanc-ink-3)] hover:text-[var(--blanc-danger,#F0503F)]"
                                    onClick={() => del.mutate()}>Remove</Button>
                            )}
                        </div>
                        <p className="mt-2.5 text-[12px] text-[var(--blanc-ink-3)]">Posts as your first name to other Albusto teams. One review per person — you can edit it later. Comments are checked before they appear.</p>
                    </div>
                </div>
            </div>
        </FloatingDetailPanel>
    );
}

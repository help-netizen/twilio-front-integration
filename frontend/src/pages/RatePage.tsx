import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

interface RateContext {
    company_name: string;
    company_logo_url: string | null;
    technician_name: string | null;
    already_rated: boolean;
    five_star_redirect: boolean;
}

interface RatingResult {
    recorded?: boolean;
    already_recorded?: boolean;
    next: 'google_redirect' | 'thanks';
    redirect_url?: string;
}

interface PublicEnvelope<T> {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string };
}

type PageState = 'loading' | 'rating' | 'thanks' | 'invalid' | 'load-error';

const STAR_VALUES = [1, 2, 3, 4, 5] as const;
const TRANSIENT_ERROR = 'Something went wrong — please try again.';

const styles: Record<string, CSSProperties> = {
    page: {
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        padding: 16,
        background: 'var(--blanc-bg)',
        color: 'var(--blanc-ink-1)',
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
    },
    card: {
        width: '100%',
        maxWidth: 440,
        boxSizing: 'border-box',
        padding: 24,
        background: 'var(--blanc-surface-strong)',
        border: '1px solid var(--blanc-line)',
        borderRadius: 24,
    },
    brand: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 28,
    },
    logo: {
        width: 52,
        height: 52,
        flex: '0 0 52px',
        borderRadius: '50%',
        objectFit: 'cover',
    },
    eyebrow: {
        margin: 0,
        color: 'var(--blanc-ink-3)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.14em',
        lineHeight: 1.4,
        textTransform: 'uppercase',
    },
    heading: {
        margin: 0,
        color: 'var(--blanc-ink-1)',
        fontFamily: "'Manrope', 'IBM Plex Sans', sans-serif",
        fontSize: 28,
        lineHeight: 1.25,
    },
    body: {
        margin: '10px 0 0',
        color: 'var(--blanc-ink-2)',
        fontSize: 16,
        lineHeight: 1.55,
    },
    stars: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        marginTop: 24,
    },
    starButton: {
        width: 48,
        height: 48,
        minWidth: 44,
        minHeight: 44,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        border: 'none',
        borderRadius: 12,
        background: 'transparent',
        fontSize: 32,
        lineHeight: 1,
        cursor: 'pointer',
        touchAction: 'manipulation',
    },
    feedbackGroup: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 24,
    },
    feedbackLabel: {
        color: 'var(--blanc-ink-1)',
        fontSize: 14,
        fontWeight: 600,
    },
    textarea: {
        width: '100%',
        minHeight: 112,
        boxSizing: 'border-box',
        padding: '13px 14px',
        color: 'var(--blanc-ink-1)',
        background: 'var(--blanc-field)',
        border: '1px solid transparent',
        borderRadius: 12,
        font: 'inherit',
        lineHeight: 1.45,
        resize: 'vertical',
    },
    primaryButton: {
        width: '100%',
        minHeight: 44,
        marginTop: 16,
        padding: '11px 16px',
        border: 'none',
        borderRadius: 12,
        color: 'var(--blanc-surface-strong)',
        background: 'var(--blanc-accent)',
        font: 'inherit',
        fontWeight: 700,
        cursor: 'pointer',
        touchAction: 'manipulation',
    },
    error: {
        margin: '16px 0 0',
        color: 'var(--blanc-danger)',
        fontSize: 14,
        lineHeight: 1.45,
    },
    centered: {
        textAlign: 'center',
    },
};

function PageFrame({ children }: { children: ReactNode }) {
    return <main style={styles.page}><section style={styles.card}>{children}</section></main>;
}

function BrandHeader({ context }: { context: RateContext }) {
    const [logoFailed, setLogoFailed] = useState(false);

    useEffect(() => {
        setLogoFailed(false);
    }, [context.company_logo_url]);

    return (
        <div style={styles.brand}>
            {context.company_logo_url && !logoFailed && (
                <img
                    src={context.company_logo_url}
                    alt=""
                    style={styles.logo}
                    onError={() => setLogoFailed(true)}
                />
            )}
            <p style={styles.eyebrow}>{context.company_name}</p>
        </div>
    );
}

interface StarPickerProps {
    selected: number | null;
    disabled: boolean;
    onSelect: (stars: number) => void;
}

function StarPicker({ selected, disabled, onSelect }: StarPickerProps) {
    return (
        <div style={styles.stars} role="group" aria-label="Rate your experience">
            {STAR_VALUES.map(star => {
                const active = selected !== null && star <= selected;
                return (
                    <button
                        key={star}
                        type="button"
                        aria-label={`${star} star${star === 1 ? '' : 's'}`}
                        aria-pressed={selected === star}
                        disabled={disabled}
                        onClick={() => onSelect(star)}
                        style={{
                            ...styles.starButton,
                            color: active ? 'var(--blanc-accent)' : 'var(--blanc-ink-3)',
                            opacity: disabled ? 0.65 : 1,
                        }}
                    >
                        ★
                    </button>
                );
            })}
        </div>
    );
}

function ThanksView({ context }: { context: RateContext }) {
    return (
        <PageFrame>
            <BrandHeader context={context} />
            <div style={styles.centered} role="status">
                <h1 style={styles.heading}>Thank you!</h1>
                <p style={styles.body}>Thanks! Your feedback means a lot to us.</p>
            </div>
        </PageFrame>
    );
}

export default function RatePage() {
    const { token } = useParams<{ token: string }>();
    const endpoint = `/api/public/rate/${encodeURIComponent(token ?? '')}`;
    const [context, setContext] = useState<RateContext | null>(null);
    const [pageState, setPageState] = useState<PageState>('loading');
    const [reloadKey, setReloadKey] = useState(0);
    const [selectedStars, setSelectedStars] = useState<number | null>(null);
    const [feedback, setFeedback] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const submitLock = useRef(false);

    useEffect(() => {
        let cancelled = false;

        setPageState('loading');
        setContext(null);
        setSelectedStars(null);
        setFeedback('');
        setSubmitError(null);

        (async () => {
            try {
                const response = await fetch(endpoint);
                if (response.status === 404) {
                    if (!cancelled) setPageState('invalid');
                    return;
                }

                const payload = await response.json() as PublicEnvelope<RateContext>;
                if (!response.ok || payload.ok === false || !payload.data) {
                    throw new Error('Context request failed');
                }
                if (cancelled) return;

                setContext(payload.data);
                setPageState(payload.data.already_rated ? 'thanks' : 'rating');
            } catch {
                if (!cancelled) setPageState('load-error');
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [endpoint, reloadKey]);

    const submitRating = async (stars: number, feedbackText?: string) => {
        if (submitLock.current) return;
        submitLock.current = true;
        setSubmitting(true);
        setSubmitError(null);

        try {
            const response = await fetch(`${endpoint}/rating`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(feedbackText === undefined ? { stars } : { stars, feedback: feedbackText }),
            });
            const payload = await response.json() as PublicEnvelope<RatingResult>;
            if (!response.ok || payload.ok === false || !payload.data) {
                throw new Error('Rating request failed');
            }

            if (payload.data.already_recorded || payload.data.next === 'thanks') {
                setPageState('thanks');
                return;
            }
            if (payload.data.next === 'google_redirect' && payload.data.redirect_url) {
                window.location.replace(payload.data.redirect_url);
                return;
            }
            throw new Error('Invalid rating response');
        } catch {
            setSubmitError(TRANSIENT_ERROR);
        } finally {
            submitLock.current = false;
            setSubmitting(false);
        }
    };

    const handleStarSelect = (stars: number) => {
        if (submitLock.current) return;
        setSelectedStars(stars);
        setSubmitError(null);
        if (stars === 5) void submitRating(5);
    };

    const handleSend = () => {
        if (selectedStars === null) return;
        void submitRating(selectedStars, selectedStars < 5 ? feedback : undefined);
    };

    if (pageState === 'loading') {
        return <PageFrame><p style={{ ...styles.body, margin: 0 }} role="status">Loading…</p></PageFrame>;
    }

    if (pageState === 'invalid') {
        return (
            <PageFrame>
                <h1 style={styles.heading}>This link is no longer available.</h1>
            </PageFrame>
        );
    }

    if (pageState === 'load-error') {
        return (
            <PageFrame>
                <h1 style={styles.heading}>{TRANSIENT_ERROR}</h1>
                <button type="button" style={styles.primaryButton} onClick={() => setReloadKey(value => value + 1)}>
                    Try again
                </button>
            </PageFrame>
        );
    }

    if (!context) return null;
    if (pageState === 'thanks') return <ThanksView context={context} />;

    const technicianName = context.technician_name || 'our technician';
    const showFeedback = selectedStars !== null && selectedStars < 5;
    const showSend = showFeedback || (selectedStars === 5 && submitError !== null);

    return (
        <PageFrame>
            <BrandHeader context={context} />
            <h1 style={styles.heading}>How did {technicianName} do?</h1>
            <StarPicker selected={selectedStars} disabled={submitting} onSelect={handleStarSelect} />

            {showFeedback && (
                <div style={styles.feedbackGroup}>
                    <label htmlFor="rate-feedback" style={styles.feedbackLabel}>What could we have done better?</label>
                    <textarea
                        id="rate-feedback"
                        value={feedback}
                        rows={4}
                        disabled={submitting}
                        onChange={event => setFeedback(event.target.value)}
                        style={styles.textarea}
                    />
                </div>
            )}

            {submitError && <p style={styles.error} role="alert">{submitError}</p>}

            {showSend && (
                <button type="button" style={styles.primaryButton} disabled={submitting} onClick={handleSend}>
                    {submitting ? 'Sending…' : 'Send'}
                </button>
            )}
        </PageFrame>
    );
}

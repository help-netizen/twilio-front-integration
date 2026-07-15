import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';

interface RateContext {
    company_name: string;
    company_logo_url: string | null;
    technician_name?: string | null;
    first_name?: string | null;
    service_label?: string | null;
    visit_date?: string | null;
    company_phone: string | null;
    company_email: string | null;
    booking_url: string | null;
    five_star_redirect?: boolean;
    already_rated?: boolean;
    expired: boolean;
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

type PageState =
    | 'loading'
    | 'invitation'
    | 'google-helper'
    | 'happy'
    | 'feedback'
    | 'feedback-thanks'
    | 'already-rated'
    | 'expired'
    | 'invalid'
    | 'load-error';

const STAR_VALUES = [1, 2, 3, 4, 5] as const;
const GOOGLE_PROMPTS = ['Punctuality', 'Clear explanation', 'Tidy work', 'Fair price', 'Friendliness'];
const FEEDBACK_PROMPTS = ['Timing', 'Communication', 'The repair', 'Pricing'];
const STAR_FILLED_COLOR = '#E0A72C';
const STAR_EMPTY_COLOR = '#D2D2D0';
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
        minHeight: 'min(600px, calc(100vh - 32px))',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        boxSizing: 'border-box',
        padding: 28,
        background: 'var(--blanc-surface-strong)',
        border: '1px solid var(--blanc-line)',
        borderRadius: 'var(--blanc-radius-xl)',
    },
    brand: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
    },
    logo: {
        width: 42,
        height: 42,
        flex: '0 0 42px',
        borderRadius: '50%',
        objectFit: 'cover',
    },
    eyebrow: {
        margin: 0,
        color: 'var(--blanc-ink-3)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.13em',
        lineHeight: 1.35,
        textTransform: 'uppercase',
    },
    greeting: {
        margin: '18px 0 4px',
        color: 'var(--blanc-ink-2)',
        fontSize: 16,
        lineHeight: 1.45,
    },
    heading: {
        margin: 0,
        color: 'var(--blanc-ink-1)',
        fontFamily: "'Manrope', 'IBM Plex Sans', sans-serif",
        fontSize: 28,
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 1.18,
    },
    body: {
        margin: '11px 0 0',
        color: 'var(--blanc-ink-2)',
        fontSize: 15,
        lineHeight: 1.6,
    },
    subline: {
        margin: '8px 0 0',
        color: 'var(--blanc-ink-2)',
        fontSize: 14,
        lineHeight: 1.5,
    },
    stars: {
        display: 'flex',
        justifyContent: 'center',
        gap: 6,
        marginTop: 28,
    },
    starsCompact: {
        justifyContent: 'flex-start',
        marginTop: 2,
        marginBottom: 12,
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
        borderRadius: 'var(--blanc-radius-sm)',
        background: 'transparent',
        fontSize: 34,
        lineHeight: 1,
        cursor: 'pointer',
        touchAction: 'manipulation',
    },
    starButtonCompact: {
        width: 44,
        height: 44,
        fontSize: 25,
    },
    starSummary: {
        display: 'flex',
        gap: 4,
        marginBottom: 12,
        fontSize: 23,
        lineHeight: 1,
    },
    hint: {
        margin: '8px 0 0',
        color: 'var(--blanc-ink-3)',
        fontSize: 13,
        textAlign: 'center',
    },
    promptLabel: {
        margin: '20px 0 10px',
        color: 'var(--blanc-ink-3)',
        fontSize: 13,
        fontWeight: 600,
    },
    chips: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        minHeight: 32,
        padding: '6px 12px',
        border: '1px solid var(--blanc-line-strong)',
        borderRadius: 999,
        color: 'var(--blanc-ink-2)',
        background: 'var(--blanc-surface-muted)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.2,
        cursor: 'default',
    },
    finePrint: {
        margin: '9px 0 0',
        color: 'var(--blanc-ink-3)',
        fontSize: 12,
        fontStyle: 'italic',
        lineHeight: 1.45,
    },
    textarea: {
        width: '100%',
        minHeight: 108,
        boxSizing: 'border-box',
        marginTop: 16,
        padding: '13px 14px',
        color: 'var(--blanc-ink-1)',
        background: 'var(--blanc-field)',
        border: '1px solid var(--blanc-line)',
        borderRadius: 'var(--blanc-radius-md)',
        font: 'inherit',
        lineHeight: 1.5,
        resize: 'vertical',
    },
    privacy: {
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 'auto',
        padding: '6px 11px',
        borderRadius: 999,
        color: 'var(--blanc-ink-2)',
        background: 'var(--blanc-field)',
        fontSize: 12,
        lineHeight: 1.35,
    },
    primaryButton: {
        width: '100%',
        minHeight: 48,
        marginTop: 18,
        padding: '12px 16px',
        border: 'none',
        borderRadius: 'var(--blanc-radius-sm)',
        color: 'var(--blanc-surface-strong)',
        background: 'var(--blanc-accent)',
        font: 'inherit',
        fontWeight: 700,
        cursor: 'pointer',
        touchAction: 'manipulation',
    },
    ghostButton: {
        width: '100%',
        minHeight: 44,
        marginTop: 6,
        padding: '10px 14px',
        border: 'none',
        color: 'var(--blanc-accent)',
        background: 'transparent',
        font: 'inherit',
        fontSize: 14,
        cursor: 'pointer',
        touchAction: 'manipulation',
    },
    centered: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
    },
    mark: {
        width: 60,
        height: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 18,
        borderRadius: '50%',
        background: 'var(--blanc-accent-soft)',
        color: 'var(--blanc-accent)',
        fontSize: 30,
        fontWeight: 700,
        lineHeight: 1,
    },
    successMark: {
        background: 'var(--blanc-task-soft)',
        color: 'var(--blanc-success)',
    },
    clockMark: {
        background: 'var(--blanc-field)',
        color: 'var(--blanc-ink-3)',
    },
    signature: {
        margin: '15px 0 0',
        color: 'var(--blanc-ink-3)',
        fontSize: 13,
        lineHeight: 1.5,
    },
    quietLink: {
        display: 'inline-block',
        marginTop: 18,
        color: 'var(--blanc-accent)',
        fontSize: 14,
        fontWeight: 700,
        textDecoration: 'none',
    },
    contacts: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 9,
        marginTop: 16,
    },
    contactLink: {
        color: 'var(--blanc-accent)',
        fontSize: 13,
        lineHeight: 1.4,
        textDecoration: 'none',
        overflowWrap: 'anywhere',
    },
    rebooking: {
        width: '100%',
        marginTop: 22,
        textAlign: 'center',
    },
    rebookingHeading: {
        margin: 0,
        color: 'var(--blanc-ink-1)',
        fontFamily: "'Manrope', 'IBM Plex Sans', sans-serif",
        fontSize: 15,
        fontWeight: 700,
        lineHeight: 1.3,
    },
    rebookingBody: {
        margin: '4px 0 0',
        color: 'var(--blanc-ink-2)',
        fontSize: 13,
        lineHeight: 1.45,
    },
    primaryLink: {
        width: '100%',
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        marginTop: 14,
        padding: '12px 16px',
        borderRadius: 'var(--blanc-radius-sm)',
        color: 'var(--blanc-surface-strong)',
        background: 'var(--blanc-accent)',
        fontSize: 14,
        fontWeight: 700,
        textDecoration: 'none',
    },
    error: {
        margin: '14px 0 0',
        color: 'var(--blanc-danger)',
        fontSize: 14,
        lineHeight: 1.45,
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
    compact?: boolean;
    onSelect: (stars: number) => void;
}

function StarPicker({ selected, disabled, compact = false, onSelect }: StarPickerProps) {
    return (
        <div
            style={{ ...styles.stars, ...(compact ? styles.starsCompact : {}) }}
            role="group"
            aria-label="Rate your experience"
        >
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
                            ...(compact ? styles.starButtonCompact : {}),
                            color: active ? STAR_FILLED_COLOR : STAR_EMPTY_COLOR,
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

function StarSummary({ stars = 5 }: { stars?: number }) {
    return (
        <div style={styles.starSummary} aria-label={`${stars} out of 5 stars`}>
            {STAR_VALUES.map(star => (
                <span key={star} aria-hidden="true" style={{ color: star <= stars ? STAR_FILLED_COLOR : STAR_EMPTY_COLOR }}>
                    ★
                </span>
            ))}
        </div>
    );
}

function PromptChips({ labels }: { labels: string[] }) {
    return (
        <div style={styles.chips}>
            {labels.map(label => (
                <button key={label} type="button" style={styles.chip}>
                    {label}
                </button>
            ))}
        </div>
    );
}

function ContactLinks({ context }: { context: RateContext }) {
    if (!context.company_phone && !context.company_email) return null;

    return (
        <div style={styles.contacts} aria-label="Company contact details">
            {context.company_phone && (
                <a href={`tel:${context.company_phone}`} style={styles.contactLink}>{context.company_phone}</a>
            )}
            {context.company_email && (
                <a href={`mailto:${context.company_email}`} style={styles.contactLink}>{context.company_email}</a>
            )}
        </div>
    );
}

function RebookingBlock({ context }: { context: RateContext }) {
    return (
        <div style={styles.rebooking}>
            <p style={styles.rebookingHeading}>Need help again?</p>
            <p style={styles.rebookingBody}>Book your next service anytime</p>
            {context.booking_url && (
                <a href={context.booking_url} style={styles.primaryLink}>Book Visit</a>
            )}
            <ContactLinks context={context} />
        </div>
    );
}

interface InvitationViewProps {
    context: RateContext;
    selectedStars: number | null;
    submitting: boolean;
    submitError: string | null;
    onSelect: (stars: number) => void;
}

function InvitationView({ context, selectedStars, submitting, submitError, onSelect }: InvitationViewProps) {
    const greeting = context.first_name ? `Hi ${context.first_name},` : 'Hi there,';
    const technicianName = context.technician_name || 'our technician';
    const visitSummary = [context.service_label, context.visit_date].filter(Boolean).join(' · ');

    return (
        <PageFrame>
            <BrandHeader context={context} />
            <p style={styles.greeting}>{greeting}</p>
            <h1 style={styles.heading}>How did {technicianName} do?</h1>
            {visitSummary && <p style={styles.subline}>{visitSummary}</p>}
            <StarPicker selected={selectedStars} disabled={submitting} onSelect={onSelect} />
            <p style={styles.hint}>{submitting ? 'Saving your rating…' : 'Tap a star to rate'}</p>
            {submitError && <p style={styles.error} role="alert">{submitError}</p>}
        </PageFrame>
    );
}

function GoogleHelperView({ onReview, onSkip }: { onReview: () => void; onSkip: () => void }) {
    return (
        <PageFrame>
            <StarSummary />
            <h1 style={styles.heading}>Wonderful — thank you.</h1>
            <p style={styles.body}>A quick word on Google means a lot to a small local crew like ours. It takes about a minute.</p>
            <p style={styles.promptLabel}>Not sure what to mention?</p>
            <PromptChips labels={GOOGLE_PROMPTS} />
            <p style={styles.finePrint}>Just prompts — your own words matter most.</p>
            <button
                type="button"
                style={{ ...styles.primaryButton, marginTop: 'auto' }}
                onClick={onReview}
            >
                Write my Google review
            </button>
            <button type="button" style={styles.ghostButton} onClick={onSkip}>Maybe another time</button>
        </PageFrame>
    );
}

function happySignature(context: RateContext) {
    if (context.technician_name) {
        return `— ${context.technician_name} & the ${context.company_name} crew`;
    }
    return `— The ${context.company_name} crew`;
}

function HappyView({ context }: { context: RateContext }) {
    return (
        <PageFrame>
            <div style={styles.centered} role="status">
                <div style={{ ...styles.mark, color: STAR_FILLED_COLOR }} aria-hidden="true">★</div>
                <h1 style={styles.heading}>
                    You're the best{context.first_name ? `, ${context.first_name}` : ''}.
                </h1>
                <p style={styles.body}>Thanks for supporting a local team. We're here whenever an appliance acts up.</p>
                <p style={styles.signature}>{happySignature(context)}</p>
                {context.booking_url && (
                    <a href={context.booking_url} style={styles.quietLink}>Book your next visit →</a>
                )}
                <ContactLinks context={context} />
            </div>
        </PageFrame>
    );
}

interface FeedbackViewProps {
    context: RateContext;
    selectedStars: number;
    feedback: string;
    submitting: boolean;
    submitError: string | null;
    onSelect: (stars: number) => void;
    onFeedbackChange: (value: string) => void;
    onSend: () => void;
}

function FeedbackView({
    context,
    selectedStars,
    feedback,
    submitting,
    submitError,
    onSelect,
    onFeedbackChange,
    onSend,
}: FeedbackViewProps) {
    return (
        <PageFrame>
            <StarPicker selected={selectedStars} disabled={submitting} compact onSelect={onSelect} />
            <h1 style={styles.heading}>Thanks for being straight with us.</h1>
            <p style={styles.body}>{"Tell us what missed the mark — this goes to our team, and won't be posted publicly."}</p>
            <textarea
                aria-label="What could we have done better?"
                placeholder="What could we have done better?"
                value={feedback}
                rows={4}
                disabled={submitting}
                onChange={event => onFeedbackChange(event.target.value)}
                style={styles.textarea}
            />
            <PromptChips labels={FEEDBACK_PROMPTS} />
            <div style={styles.privacy}>▣ Private — only {context.company_name} sees this</div>
            {submitError && <p style={styles.error} role="alert">{submitError}</p>}
            <button type="button" style={styles.primaryButton} disabled={submitting} onClick={onSend}>
                {submitting ? 'Sending…' : 'Send to the team'}
            </button>
        </PageFrame>
    );
}

function FeedbackThanksView({ context }: { context: RateContext }) {
    return (
        <PageFrame>
            <div style={styles.centered} role="status">
                <div style={{ ...styles.mark, ...styles.successMark }} aria-hidden="true">✓</div>
                <h1 style={styles.heading}>Thank you — we hear you.</h1>
                <p style={styles.body}>A manager from {context.company_name} will reach out to make this right.</p>
                <div style={styles.rebooking}>
                    <p style={styles.rebookingHeading}>Prefer to talk now?</p>
                    <ContactLinks context={context} />
                </div>
            </div>
        </PageFrame>
    );
}

function alreadyRatedMessage(context: RateContext) {
    const greeting = context.first_name ? `, ${context.first_name}` : '';
    const recipient = context.technician_name ? `${context.technician_name} and the team` : 'the team';
    return `Thanks again${greeting} — it means a lot to ${recipient}.`;
}

function AlreadyRatedView({ context }: { context: RateContext }) {
    return (
        <PageFrame>
            <div style={styles.centered} role="status">
                <div style={styles.mark} aria-hidden="true">✓</div>
                <h1 style={styles.heading}>You've already rated this visit.</h1>
                <p style={styles.body}>{alreadyRatedMessage(context)}</p>
                <RebookingBlock context={context} />
            </div>
        </PageFrame>
    );
}

function ExpiredView({ context }: { context: RateContext }) {
    return (
        <PageFrame>
            <div style={styles.centered} role="status">
                <div style={{ ...styles.mark, ...styles.clockMark }} aria-hidden="true">◷</div>
                <h1 style={styles.heading}>This link has expired.</h1>
                <p style={styles.body}>Rating links stay active for a while after your visit.</p>
                <RebookingBlock context={context} />
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
    const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const submitLock = useRef(false);

    useEffect(() => {
        let cancelled = false;

        submitLock.current = false;
        setPageState('loading');
        setContext(null);
        setSelectedStars(null);
        setFeedback('');
        setRedirectUrl(null);
        setSubmitting(false);
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
                if (payload.data.expired === true) {
                    setPageState('expired');
                } else if (payload.data.already_rated === true) {
                    setPageState('already-rated');
                } else {
                    setPageState('invitation');
                }
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

            if (payload.data.already_recorded) {
                setPageState('already-rated');
                return;
            }
            if (stars === 5 && payload.data.next === 'google_redirect' && payload.data.redirect_url) {
                setRedirectUrl(payload.data.redirect_url);
                setPageState('google-helper');
                return;
            }
            if (payload.data.next === 'thanks') {
                setPageState(stars === 5 ? 'happy' : 'feedback-thanks');
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

        if (stars === 5) {
            void submitRating(5);
            return;
        }
        setPageState('feedback');
    };

    const handleSend = () => {
        if (selectedStars === null) return;
        void submitRating(selectedStars, feedback);
    };

    const handleGoogleReview = () => {
        if (!redirectUrl) return;
        fetch(`${endpoint}/click`, { method: 'POST', keepalive: true }).catch(() => {});
        window.open(redirectUrl, '_blank', 'noopener');
        setPageState('happy');
    };

    if (pageState === 'loading') {
        return (
            <PageFrame>
                <div style={styles.centered}><p style={{ ...styles.body, margin: 0 }} role="status">Loading…</p></div>
            </PageFrame>
        );
    }

    if (pageState === 'invalid') {
        return (
            <PageFrame>
                <div style={styles.centered}><h1 style={styles.heading}>This link is no longer available.</h1></div>
            </PageFrame>
        );
    }

    if (pageState === 'load-error') {
        return (
            <PageFrame>
                <div style={styles.centered}>
                    <h1 style={styles.heading}>{TRANSIENT_ERROR}</h1>
                    <button type="button" style={styles.primaryButton} onClick={() => setReloadKey(value => value + 1)}>
                        Try again
                    </button>
                </div>
            </PageFrame>
        );
    }

    if (!context) return null;

    if (pageState === 'invitation') {
        return (
            <InvitationView
                context={context}
                selectedStars={selectedStars}
                submitting={submitting}
                submitError={submitError}
                onSelect={handleStarSelect}
            />
        );
    }

    if (pageState === 'google-helper') {
        return (
            <GoogleHelperView
                onReview={handleGoogleReview}
                onSkip={() => setPageState('happy')}
            />
        );
    }

    if (pageState === 'happy') return <HappyView context={context} />;

    if (pageState === 'feedback' && selectedStars !== null) {
        return (
            <FeedbackView
                context={context}
                selectedStars={selectedStars}
                feedback={feedback}
                submitting={submitting}
                submitError={submitError}
                onSelect={handleStarSelect}
                onFeedbackChange={setFeedback}
                onSend={handleSend}
            />
        );
    }

    if (pageState === 'feedback-thanks') return <FeedbackThanksView context={context} />;
    if (pageState === 'already-rated') return <AlreadyRatedView context={context} />;
    if (pageState === 'expired') return <ExpiredView context={context} />;

    return null;
}

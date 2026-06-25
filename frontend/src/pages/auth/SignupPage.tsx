/**
 * SignupPage — ALB-101 self-registration (public, no auth).
 *
 * Steps: account (email/password or Google) → "check your email".
 * Phone verification + company creation continue in /onboarding after the
 * first login (email must be verified to sign in).
 *
 * Styled to match the Albusto Keycloak login theme (two-column shell, the same
 * "Why Albusto" benefits on the right). See ./auth-shell.css.
 */

import { useEffect, useState } from 'react';
import { Loader2, Mail, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { getKeycloak } from '../../auth/AuthProvider';
import './auth-shell.css';

const BENEFITS = [
    {
        title: 'Free forever',
        text: 'Unlimited users, no seat fees. You only pay for calls and minutes.',
        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z" /></svg>,
    },
    {
        title: 'Apps marketplace',
        text: 'Connect the tools you already use in a click.',
        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
    },
    {
        title: 'Automation built in',
        text: 'Customer relationships and jobs, handled for you.',
        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7h6M3 12h12M3 17h8" /><circle cx="17.5" cy="8" r="2.5" /><path d="M19 18.5a2.5 2.5 0 1 0-3.5 0" /></svg>,
    },
    {
        title: 'Stay on the pulse',
        text: 'Calls, texts and email — all in one window.',
        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12h4l2 5 4-12 2 7h6" /></svg>,
    },
];

function WhyAlbusto() {
    return (
        <div className="auth__news-col" aria-hidden="true">
            <div className="promo">
                <div className="eyebrow">Why Albusto</div>
                <h2 className="promo__title">Everything your front office needs</h2>
                <ul className="benefits">
                    {BENEFITS.map((b) => (
                        <li className="benefit" key={b.title}>
                            <span className="benefit__icon">{b.icon}</span>
                            <div>
                                <div className="benefit__title">{b.title}</div>
                                <div className="benefit__text">{b.text}</div>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

export function SignupPage() {
    const [step, setStep] = useState<'account' | 'email-sent'>('account');
    const [email, setEmail] = useState('');
    const [fullName, setFullName] = useState('');
    const [password, setPassword] = useState('');
    const [showPw, setShowPw] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendIn, setResendIn] = useState(0);

    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setTimeout(() => setResendIn(s => s - 1), 1000);
        return () => clearTimeout(t);
    }, [resendIn]);

    const register = async (): Promise<boolean> => {
        const res = await fetch('/api/public/signup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim(), password, full_name: fullName.trim() }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { setError(json.message || 'Could not create the account — try again'); return false; }
        return true;
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
        setBusy(true);
        try {
            if (await register()) { setStep('email-sent'); setResendIn(30); }
        } catch { setError('Connection error — try again'); }
        finally { setBusy(false); }
    };

    const resend = async () => {
        setError(null); setBusy(true);
        try { if (await register()) setResendIn(30); }
        catch { setError('Connection error — try again'); }
        finally { setBusy(false); }
    };

    const googleSignup = () => {
        getKeycloak().login({ idpHint: 'google', redirectUri: window.location.origin + '/onboarding' });
    };

    return (
        <div className="albusto-auth-shell">
            <div className="auth__form-col">
                <div className="brand">
                    <div className="brand__mark">A</div>
                    <div>
                        <div className="brand__name">Albusto</div>
                        <div className="brand__sub">Contact center</div>
                    </div>
                </div>

                <div className="form-wrap">
                    {step === 'account' && (
                        <>
                            <h1>Create your workspace</h1>
                            <p className="lede">Start qualifying and booking leads in minutes.</p>

                            <button type="button" className="btn btn--ghost" onClick={googleSignup}>
                                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" /></svg>
                                Continue with Google
                            </button>

                            <div className="divider">or with email</div>

                            <form onSubmit={submit}>
                                <div className="field">
                                    <input id="fullName" placeholder=" " value={fullName} onChange={e => setFullName(e.target.value)} required autoFocus autoComplete="name" />
                                    <label htmlFor="fullName">Full name</label>
                                </div>
                                <div className="field">
                                    <input id="email" type="email" placeholder=" " value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
                                    <label htmlFor="email">Work email</label>
                                </div>
                                <div className="field">
                                    <input id="password" type={showPw ? 'text' : 'password'} placeholder=" " value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
                                    <label htmlFor="password">Password</label>
                                    <button type="button" className="field__toggle" onClick={() => setShowPw(v => !v)} tabIndex={-1} aria-label={showPw ? 'Hide password' : 'Show password'}>
                                        {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                                    </button>
                                </div>

                                {error && <div role="alert" className="field-error">{error}</div>}

                                <button type="submit" className="btn" disabled={busy} aria-busy={busy} style={{ marginTop: 8 }}>
                                    {busy ? <Loader2 size={17} className="animate-spin" /> : <>Create account <ArrowRight size={16} /></>}
                                </button>
                            </form>

                            <p className="aux">Already have an account? <a className="link" href="/">Sign in</a></p>
                        </>
                    )}

                    {step === 'email-sent' && (
                        <div className="sent">
                            <div className="sent__icon"><Mail size={24} /></div>
                            <h1>Check your email</h1>
                            <p className="lede">We sent a verification link to <strong style={{ color: 'var(--blanc-ink-1)' }}>{email}</strong>.</p>
                            <p className="muted">After you confirm it, sign in to finish setting up your company.</p>

                            {error && <div role="alert" className="field-error" style={{ marginBottom: 12 }}>{error}</div>}

                            <a href="/" className="btn" style={{ marginTop: 18 }}>Go to sign in</a>
                            <div className="sent__row">
                                <button type="button" className="textbtn" onClick={resend} disabled={busy || resendIn > 0}>
                                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend email'}
                                </button>
                                <button type="button" className="textbtn textbtn--muted" onClick={() => { setStep('account'); setError(null); }}>
                                    Use a different email
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="form-foot"><span className="dot" /> Secure sign-up · Albusto CRM</div>
                </div>
            </div>

            <WhyAlbusto />
        </div>
    );
}

export default SignupPage;

/**
 * SignupPage — ALB-101 self-registration (public, no auth).
 *
 * Steps: account (email/password or Google) → "check your email".
 * Phone verification + company creation continue in /onboarding after the
 * first login (email must be verified to sign in).
 */

import { useEffect, useState } from 'react';
import { Loader2, Mail, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { getKeycloak } from '../../auth/AuthProvider';

const card: React.CSSProperties = {
    width: '100%', maxWidth: 440, background: 'var(--blanc-surface-strong, #fdf8f0)',
    borderRadius: 22, padding: '34px 32px', border: '1px solid var(--blanc-line, rgba(117,106,89,0.18))',
};
const inputStyle: React.CSSProperties = {
    width: '100%', height: 44, borderRadius: 10, padding: '0 14px',
    border: '1px solid var(--blanc-line, rgba(117,106,89,0.25))', fontSize: 15,
    background: '#fff', outline: 'none', color: 'var(--blanc-ink-1, #202734)', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
    fontSize: 12.5, color: 'var(--blanc-ink-2, #536070)', display: 'block', marginBottom: 6,
};
const primaryBtn: React.CSSProperties = {
    width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer',
    background: 'var(--blanc-job, #2f63d8)', color: '#fff', fontSize: 15, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
};

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
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--blanc-bg, #efe9df)',
            fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif', padding: 16,
        }}>
            <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--blanc-ink-2, #536070)', fontFamily: 'Manrope, sans-serif', marginBottom: 14 }}>Albusto</div>

                {step === 'account' && (
                    <>
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, fontWeight: 600, margin: '0 0 4px', color: 'var(--blanc-ink-1, #202734)' }}>Create your workspace</h1>
                        <p style={{ margin: '0 0 22px', color: 'var(--blanc-ink-3, #7d8796)', fontSize: 14 }}>Start qualifying and booking leads in minutes.</p>

                        <button type="button" onClick={googleSignup} style={{
                            ...primaryBtn, background: '#fff', color: 'var(--blanc-ink-1, #202734)',
                            border: '1px solid var(--blanc-line, rgba(117,106,89,0.25))', fontWeight: 500,
                        }}>
                            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
                            Continue with Google
                        </button>

                        <div style={{ textAlign: 'center', margin: '16px 0', color: 'var(--blanc-ink-3, #7d8796)', fontSize: 12.5 }}>or with email</div>

                        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div>
                                <label style={labelStyle}>Full name</label>
                                <input style={inputStyle} value={fullName} onChange={e => setFullName(e.target.value)} required autoFocus placeholder="Jane Doe" />
                            </div>
                            <div>
                                <label style={labelStyle}>Work email</label>
                                <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@company.com" />
                            </div>
                            <div>
                                <label style={labelStyle}>Password</label>
                                <div style={{ position: 'relative' }}>
                                    <input style={{ ...inputStyle, paddingRight: 42 }} type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters" />
                                    <button type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}
                                        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-3, #7d8796)', padding: 8, display: 'flex' }}>
                                        {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                                    </button>
                                </div>
                            </div>

                            {error && <div role="alert" style={{ color: 'var(--blanc-danger, #d44d3c)', fontSize: 13 }}>{error}</div>}

                            <button type="submit" disabled={busy} aria-busy={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                                {busy ? <Loader2 size={17} className="animate-spin" /> : <>Create account <ArrowRight size={16} /></>}
                            </button>
                        </form>

                        <p style={{ margin: '18px 0 0', fontSize: 13, color: 'var(--blanc-ink-3, #7d8796)', textAlign: 'center' }}>
                            Already have an account? <a href="/" style={{ color: 'var(--blanc-job, #2f63d8)', fontWeight: 600, textDecoration: 'none' }}>Sign in</a>
                        </p>
                    </>
                )}

                {step === 'email-sent' && (
                    <div style={{ textAlign: 'center', padding: '8px 0' }}>
                        <Mail size={30} style={{ color: 'var(--blanc-ink-3, #7d8796)', margin: '4px auto 14px' }} />
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, fontWeight: 600, margin: '0 0 8px', color: 'var(--blanc-ink-1, #202734)' }}>Check your email</h1>
                        <p style={{ margin: '0 0 6px', color: 'var(--blanc-ink-2, #536070)', fontSize: 14, lineHeight: 1.6 }}>
                            We sent a verification link to <strong style={{ color: 'var(--blanc-ink-1, #202734)' }}>{email}</strong>.
                        </p>
                        <p style={{ margin: '0 0 22px', color: 'var(--blanc-ink-3, #7d8796)', fontSize: 13.5 }}>After you confirm it, sign in to finish setting up your company.</p>

                        {error && <div role="alert" style={{ color: 'var(--blanc-danger, #d44d3c)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

                        <a href="/" style={{ ...primaryBtn, textDecoration: 'none', marginBottom: 12 }}>Go to sign in</a>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 18, fontSize: 13 }}>
                            <button type="button" onClick={resend} disabled={busy || resendIn > 0}
                                style={{ background: 'none', border: 'none', fontWeight: 600, cursor: resendIn > 0 ? 'default' : 'pointer', color: resendIn > 0 ? 'var(--blanc-ink-3, #7d8796)' : 'var(--blanc-job, #2f63d8)' }}>
                                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend email'}
                            </button>
                            <button type="button" onClick={() => { setStep('account'); setError(null); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-2, #536070)' }}>
                                Use a different email
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default SignupPage;

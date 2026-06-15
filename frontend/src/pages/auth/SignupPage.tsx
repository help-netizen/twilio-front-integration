/**
 * SignupPage — ALB-101 self-registration (public, no auth).
 *
 * Steps: account (email/password or Google) → "check your email".
 * Phone verification + company creation continue in /onboarding after the
 * first login (email must be verified to sign in).
 */

import { useState } from 'react';
import { Loader2, Mail, ArrowRight } from 'lucide-react';
import { getKeycloak } from '../../auth/AuthProvider';

const card: React.CSSProperties = {
    width: '100%', maxWidth: 420, background: 'var(--blanc-surface-strong, #fffdf9)',
    borderRadius: 22, padding: '36px 32px',
    border: '1px solid rgba(117, 106, 89, 0.18)',
};
const inputStyle: React.CSSProperties = {
    width: '100%', height: 44, borderRadius: 10, padding: '0 14px',
    border: '1px solid rgba(117, 106, 89, 0.25)', fontSize: 15,
    background: '#fff', outline: 'none',
};
const labelStyle: React.CSSProperties = {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em',
    color: 'rgba(60, 54, 44, 0.55)', display: 'block', marginBottom: 6,
};
const primaryBtn: React.CSSProperties = {
    width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer',
    background: '#3c362c', color: '#fffdf9', fontSize: 15, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
};

export function SignupPage() {
    const [step, setStep] = useState<'account' | 'email-sent'>('account');
    const [email, setEmail] = useState('');
    const [fullName, setFullName] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
        setBusy(true);
        try {
            const res = await fetch('/api/public/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim(), password, full_name: fullName.trim() }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(json.message || 'Could not create the account — try again');
                return;
            }
            setStep('email-sent');
        } catch {
            setError('Connection error — try again');
        } finally {
            setBusy(false);
        }
    };

    const googleSignup = () => {
        // Keycloak Google IdP: after Google auth the user lands back logged in;
        // the onboarding gate collects phone + company.
        getKeycloak().login({ idpHint: 'google', redirectUri: window.location.origin + '/onboarding' });
    };

    return (
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(180deg, #f7f3ec 0%, #f1ebe1 100%)',
            fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif', padding: 16,
        }}>
            <div style={card}>
                <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 26, margin: '0 0 4px', color: '#2c2722' }}>Albusto</h1>

                {step === 'account' && (
                    <>
                        <p style={{ margin: '0 0 24px', color: 'rgba(60,54,44,0.65)', fontSize: 14 }}>
                            Create your company workspace
                        </p>

                        <button type="button" onClick={googleSignup} style={{
                            ...primaryBtn, background: '#fff', color: '#3c362c',
                            border: '1px solid rgba(117, 106, 89, 0.25)', marginBottom: 18,
                        }}>
                            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
                            Continue with Google
                        </button>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 18px', color: 'rgba(60,54,44,0.4)', fontSize: 12 }}>
                            <div style={{ flex: 1, height: 1, background: 'rgba(117,106,89,0.15)' }} />
                            or with email
                            <div style={{ flex: 1, height: 1, background: 'rgba(117,106,89,0.15)' }} />
                        </div>

                        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                                <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters" />
                            </div>

                            {error && <div style={{ color: '#b3422f', fontSize: 13 }}>{error}</div>}

                            <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                                {busy ? <Loader2 size={17} className="animate-spin" /> : <>Create account <ArrowRight size={16} /></>}
                            </button>
                        </form>

                        <p style={{ margin: '18px 0 0', fontSize: 13, color: 'rgba(60,54,44,0.55)', textAlign: 'center' }}>
                            Already have an account?{' '}
                            <a href="/" style={{ color: '#3c362c', fontWeight: 600 }}>Sign in</a>
                        </p>
                    </>
                )}

                {step === 'email-sent' && (
                    <div style={{ textAlign: 'center', padding: '12px 0' }}>
                        <div style={{
                            width: 56, height: 56, borderRadius: 28, margin: '8px auto 16px',
                            background: 'rgba(117, 106, 89, 0.08)', display: 'flex',
                            alignItems: 'center', justifyContent: 'center',
                        }}>
                            <Mail size={24} color="#3c362c" />
                        </div>
                        <h2 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 20, margin: '0 0 8px', color: '#2c2722' }}>Check your email</h2>
                        <p style={{ margin: '0 0 20px', color: 'rgba(60,54,44,0.65)', fontSize: 14, lineHeight: 1.5 }}>
                            We sent a verification link to<br /><strong>{email}</strong>.<br />
                            Confirm it, then sign in to finish setting up your company.
                        </p>
                        <a href="/" style={{ ...primaryBtn, textDecoration: 'none' }}>Go to sign in</a>
                    </div>
                )}
            </div>
        </div>
    );
}

export default SignupPage;

/**
 * OnboardingPage — ALB-101 (authenticated, pre-tenant).
 *
 * One flowing screen, two steps:
 *  1. Phone + 6-digit SMS code (possession proof → otp_token)
 *  2. Company name + "City or ZIP" with Google Places autocomplete
 *     (timezone derived server-side — never asked).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, MapPin, ArrowRight, ShieldCheck } from 'lucide-react';
import { authedFetch } from '../../services/apiClient';

const card: React.CSSProperties = {
    width: '100%', maxWidth: 460, background: 'var(--blanc-surface-strong, #fffdf9)',
    borderRadius: 22, padding: '36px 32px', border: '1px solid rgba(117, 106, 89, 0.18)',
};
const inputStyle: React.CSSProperties = {
    width: '100%', height: 44, borderRadius: 10, padding: '0 14px',
    border: '1px solid rgba(117, 106, 89, 0.25)', fontSize: 15, background: '#fff', outline: 'none',
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

interface Suggestion { place_id: string; description: string }

export function OnboardingPage() {
    const navigate = useNavigate();
    const [step, setStep] = useState<'phone' | 'code' | 'company'>('phone');
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [otpToken, setOtpToken] = useState<string | null>(null);
    const [resendIn, setResendIn] = useState(0);
    const [companyName, setCompanyName] = useState('');
    const [placeQuery, setPlaceQuery] = useState('');
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [picked, setPicked] = useState<Suggestion | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const codeRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Already onboarded → straight to the product
    useEffect(() => {
        authedFetch('/api/onboarding/status')
            .then(r => r.json())
            .then(j => { if (j.onboarded) navigate('/pulse', { replace: true }); })
            .catch(() => {});
    }, [navigate]);

    // Resend countdown
    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setTimeout(() => setResendIn(s => s - 1), 1000);
        return () => clearTimeout(t);
    }, [resendIn]);

    // Places autocomplete (debounced)
    useEffect(() => {
        if (picked) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (placeQuery.trim().length < 2) { setSuggestions([]); return; }
        debounceRef.current = setTimeout(() => {
            fetch(`/api/public/places/suggest?q=${encodeURIComponent(placeQuery.trim())}`)
                .then(r => r.json())
                .then(j => setSuggestions(j.suggestions || []))
                .catch(() => setSuggestions([]));
        }, 250);
    }, [placeQuery, picked]);

    const sendCode = async () => {
        setError(null); setBusy(true);
        try {
            const res = await fetch('/api/public/otp/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, purpose: 'signup' }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.message || 'Could not send the code'); return; }
            setStep('code');
            setResendIn(json.resend_after_sec || 30);
            setTimeout(() => codeRef.current?.focus(), 50);
        } catch { setError('Connection error'); } finally { setBusy(false); }
    };

    const verifyCode = async (value: string) => {
        setError(null); setBusy(true);
        try {
            const res = await fetch('/api/public/otp/verify', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, purpose: 'signup', code: value }),
            });
            const json = await res.json();
            if (!res.ok) {
                setError(json.code === 'OTP_EXPIRED'
                    ? 'Code expired — request a new one'
                    : `Incorrect code${json.attempts_left ? ` — ${json.attempts_left} attempts left` : ''}`);
                setCode('');
                return;
            }
            setOtpToken(json.otp_token);
            setStep('company');
        } catch { setError('Connection error'); } finally { setBusy(false); }
    };

    const onCodeChange = (v: string) => {
        const digits = v.replace(/\D/g, '').slice(0, 6);
        setCode(digits);
        if (digits.length === 6) verifyCode(digits); // auto-submit
    };

    const createCompany = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null); setBusy(true);
        try {
            const res = await authedFetch('/api/onboarding', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    company_name: companyName.trim(),
                    place: picked ? { place_id: picked.place_id } : undefined,
                    manual: !picked && placeQuery.trim() ? { city: placeQuery.trim() } : undefined,
                    otp_token: otpToken,
                }),
            });
            const json = await res.json();
            if (!res.ok) {
                if (json.code === 'ALREADY_ONBOARDED') { navigate('/pulse', { replace: true }); return; }
                setError(json.message || 'Could not create the company');
                return;
            }
            window.location.href = json.redirect || '/pulse';
        } catch { setError('Connection error'); } finally { setBusy(false); }
    };

    return (
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(180deg, #f7f3ec 0%, #f1ebe1 100%)',
            fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif', padding: 16,
        }}>
            <div style={card}>
                <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 26, margin: '0 0 4px', color: '#2c2722' }}>Albusto</h1>
                <p style={{ margin: '0 0 24px', color: 'rgba(60,54,44,0.65)', fontSize: 14 }}>
                    {step === 'company' ? 'Last step — your company' : 'Secure your account'}
                </p>

                {step === 'phone' && (
                    <form onSubmit={e => { e.preventDefault(); sendCode(); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                            <label style={labelStyle}>Mobile phone</label>
                            <input style={inputStyle} type="tel" value={phone} autoFocus required
                                placeholder="(617) 555-0142"
                                onChange={e => setPhone(e.target.value)} />
                            <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'rgba(60,54,44,0.5)', display: 'flex', gap: 6, alignItems: 'center' }}>
                                <ShieldCheck size={14} /> Used to confirm sign-ins with a 6-digit SMS code
                            </p>
                        </div>
                        {error && <div style={{ color: '#b3422f', fontSize: 13 }}>{error}</div>}
                        <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                            {busy ? <Loader2 size={17} className="animate-spin" /> : <>Send code <ArrowRight size={16} /></>}
                        </button>
                    </form>
                )}

                {step === 'code' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                            <label style={labelStyle}>Enter the 6-digit code sent to {phone}</label>
                            <input ref={codeRef} style={{ ...inputStyle, letterSpacing: '0.5em', textAlign: 'center', fontSize: 20, fontVariantNumeric: 'tabular-nums' }}
                                inputMode="numeric" autoComplete="one-time-code"
                                value={code} onChange={e => onCodeChange(e.target.value)} />
                        </div>
                        {error && <div style={{ color: '#b3422f', fontSize: 13 }}>{error}</div>}
                        {busy && <div style={{ display: 'flex', justifyContent: 'center' }}><Loader2 size={18} className="animate-spin" /></div>}
                        <button type="button" disabled={resendIn > 0}
                            onClick={sendCode}
                            style={{ background: 'none', border: 'none', cursor: resendIn > 0 ? 'default' : 'pointer', color: resendIn > 0 ? 'rgba(60,54,44,0.4)' : '#3c362c', fontSize: 13, fontWeight: 600 }}>
                            {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                        </button>
                        <button type="button" onClick={() => { setStep('phone'); setCode(''); setError(null); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(60,54,44,0.5)', fontSize: 13 }}>
                            Change phone number
                        </button>
                    </div>
                )}

                {step === 'company' && (
                    <form onSubmit={createCompany} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                            <label style={labelStyle}>Company name</label>
                            <input style={inputStyle} value={companyName} autoFocus required minLength={2}
                                placeholder="Acme Appliance Repair" onChange={e => setCompanyName(e.target.value)} />
                        </div>
                        <div style={{ position: 'relative' }}>
                            <label style={labelStyle}>City or ZIP code</label>
                            <input style={inputStyle} value={picked ? picked.description : placeQuery} required
                                placeholder="Boston or 02101"
                                onChange={e => { setPicked(null); setPlaceQuery(e.target.value); }} />
                            {!picked && suggestions.length > 0 && (
                                <div style={{
                                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                                    background: '#fff', border: '1px solid rgba(117,106,89,0.18)',
                                    borderRadius: 10, marginTop: 4, overflow: 'hidden',
                                    boxShadow: '0 8px 24px rgba(60,54,44,0.08)',
                                }}>
                                    {suggestions.map(sg => (
                                        <button key={sg.place_id} type="button"
                                            onClick={() => { setPicked(sg); setSuggestions([]); }}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                                padding: '10px 12px', border: 'none', background: 'none',
                                                cursor: 'pointer', fontSize: 14, textAlign: 'left', color: '#2c2722',
                                            }}>
                                            <MapPin size={14} color="rgba(60,54,44,0.45)" />{sg.description}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'rgba(60,54,44,0.5)' }}>
                                We'll set your timezone and service area from this
                            </p>
                        </div>
                        {error && <div style={{ color: '#b3422f', fontSize: 13 }}>{error}</div>}
                        <button type="submit" disabled={busy || !companyName.trim()} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                            {busy ? <Loader2 size={17} className="animate-spin" /> : <>Open my workspace <ArrowRight size={16} /></>}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

export default OnboardingPage;

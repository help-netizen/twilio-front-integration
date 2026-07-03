/**
 * OnboardingPage — ALB-101 (authenticated, pre-tenant).
 *
 * One flowing screen, three steps:
 *  1. Phone, then a 6-digit SMS code (possession proof → otp_token)
 *  2. Company name + "City or ZIP" with Google Places autocomplete
 *     (timezone derived server-side — never asked).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, MapPin, ArrowRight, ArrowLeft, ShieldCheck } from 'lucide-react';
import { authedFetch } from '../../services/apiClient';
import { useAuth } from '../../auth/AuthProvider';
import { formatUSPhone, toE164 } from '../../components/ui/PhoneInput';

const card: React.CSSProperties = {
    width: '100%', maxWidth: 440, background: 'var(--blanc-surface-strong, #fdf8f0)',
    borderRadius: 22, padding: '30px 32px', border: '1px solid var(--blanc-line, var(--blanc-line))',
};
const inputStyle: React.CSSProperties = {
    width: '100%', height: 44, borderRadius: 10, padding: '0 14px',
    border: '1px solid var(--blanc-line, var(--blanc-line-strong))', fontSize: 15, background: '#fff',
    outline: 'none', color: 'var(--blanc-ink-1, #202734)', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
    fontSize: 12.5, color: 'var(--blanc-ink-2, #536070)', display: 'block', marginBottom: 6,
};
const primaryBtn: React.CSSProperties = {
    width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer',
    background: 'var(--blanc-job, #2f63d8)', color: '#fff', fontSize: 15, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
};

interface Suggestion { place_id: string; description: string }

function OtpCells({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
    const refs = useRef<Array<HTMLInputElement | null>>([]);
    useEffect(() => { refs.current[0]?.focus(); }, []);
    useEffect(() => { if (value === '') refs.current[0]?.focus(); }, [value]);

    const setCell = (i: number, raw: string) => {
        const c = raw.replace(/\D/g, '').slice(-1);
        if (!c) return;
        const arr = value.split('');
        while (arr.length < i) arr.push('');
        arr[i] = c;
        onChange(arr.join('').slice(0, 6));
        if (i < 5) refs.current[i + 1]?.focus();
    };
    const onKey = (i: number, e: React.KeyboardEvent) => {
        if (e.key !== 'Backspace') return;
        const arr = value.split('');
        if (value[i]) { arr[i] = ''; onChange(arr.join('')); }
        else if (i > 0) { e.preventDefault(); arr[i - 1] = ''; onChange(arr.join('')); refs.current[i - 1]?.focus(); }
    };
    const onPaste = (e: React.ClipboardEvent) => {
        const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!t) return;
        e.preventDefault();
        onChange(t);
        refs.current[Math.min(t.length, 5)]?.focus();
    };
    return (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }} onPaste={onPaste}>
            {Array.from({ length: 6 }).map((_, i) => (
                <input key={i} ref={el => { refs.current[i] = el; }} value={value[i] || ''} disabled={disabled}
                    inputMode="numeric" maxLength={1} autoComplete={i === 0 ? 'one-time-code' : 'off'}
                    aria-label={`Digit ${i + 1}`}
                    onChange={e => setCell(i, e.target.value)} onKeyDown={e => onKey(i, e)}
                    style={{
                        width: 46, height: 54, textAlign: 'center', fontSize: 22, fontWeight: 600,
                        fontFamily: 'Manrope, sans-serif', color: 'var(--blanc-ink-1, #202734)',
                        border: '1px solid var(--blanc-line, var(--blanc-line-strong))', borderRadius: 12,
                        background: '#fff', outline: 'none',
                    }} />
            ))}
        </div>
    );
}

export function OnboardingPage() {
    const navigate = useNavigate();
    const { refreshAuthz } = useAuth();
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
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        authedFetch('/api/onboarding/status').then(r => r.json())
            .then(j => { if (j.onboarded) navigate('/pulse', { replace: true }); }).catch(() => {});
    }, [navigate]);

    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setTimeout(() => setResendIn(s => s - 1), 1000);
        return () => clearTimeout(t);
    }, [resendIn]);

    useEffect(() => {
        if (picked) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (placeQuery.trim().length < 2) { setSuggestions([]); return; }
        debounceRef.current = setTimeout(() => {
            fetch(`/api/public/places/suggest?q=${encodeURIComponent(placeQuery.trim())}`)
                .then(r => r.json()).then(j => setSuggestions(j.suggestions || [])).catch(() => setSuggestions([]));
        }, 250);
    }, [placeQuery, picked]);

    const sendCode = async () => {
        setError(null); setBusy(true);
        try {
            const res = await fetch('/api/public/otp/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: toE164(phone), purpose: 'signup' }),
            });
            const json = await res.json();
            // Rate limited (AUTH-FLOW-FIX-001 R7): show the wait and start the
            // countdown from retry_after_sec; the Resend button stays disabled
            // while resendIn > 0, so the UI can't spam the SMS endpoint.
            if (res.status === 429 || json.code === 'OTP_RATE_LIMITED') {
                if (step === 'phone') setStep('code');
                setError(json.message || 'Too many attempts — please wait a moment.');
                setResendIn(Math.max(1, Number(json.retry_after_sec) || 60));
                return;
            }
            if (!res.ok) { setError(json.message || 'Could not send the code'); return; }
            setStep('code'); setCode('');
            setResendIn(json.resend_after_sec || 30);
        } catch { setError('Connection error'); } finally { setBusy(false); }
    };

    const verifyCode = async (value: string) => {
        setError(null); setBusy(true);
        try {
            const res = await fetch('/api/public/otp/verify', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: toE164(phone), purpose: 'signup', code: value }),
            });
            const json = await res.json();
            if (!res.ok) {
                if (json.code === 'OTP_EXPIRED') { setError('Code expired — request a new one'); setResendIn(0); }
                else setError(`Incorrect code${json.attempts_left ? ` — ${json.attempts_left} attempts left` : ''}`);
                setCode('');
                return;
            }
            setOtpToken(json.otp_token);
            setStep('company');
        } catch { setError('Connection error'); } finally { setBusy(false); }
    };

    const onCodeChange = (digits: string) => {
        setCode(digits);
        if (digits.length === 6) verifyCode(digits);
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
                // Already belongs to a company (e.g. a Google login linked to an
                // existing account): refresh authz so the SPA reflects that company
                // before landing — otherwise the stale (no-company) context loops
                // the onboarding gate and 403s /pulse. (ONBOARD-FIX-001 A)
                if (json.code === 'ALREADY_ONBOARDED') { await refreshAuthz(); navigate('/pulse', { replace: true }); return; }
                setError(json.message || 'Could not create the company'); return;
            }

            // ONBOARD-FIX-001 (A): the company + tenant_admin membership now exist
            // server-side, but the authz context was loaded at app init (no company).
            // Re-pull it BEFORE navigating so OnboardingGate sees a company (no
            // redirect loop / flicker) and /pulse's permission check passes.
            await refreshAuthz();
            // The device is now trusted server-side (AUTH-FLOW-FIX-001 R4), so the
            // 2FA gate won't fire on /pulse. Land via client-side navigation when
            // the target is in-SPA — a full-page reload here would re-boot the app
            // and could surface a transient 401 → gate → SMS loop. Only fall back
            // to a hard navigation for an external/absolute redirect URL.
            const redirect: string = json.redirect || '/pulse';
            const isExternal = /^https?:\/\//i.test(redirect) &&
                !redirect.startsWith(window.location.origin);
            if (isExternal) {
                window.location.href = redirect;
            } else {
                const path = redirect.startsWith(window.location.origin)
                    ? redirect.slice(window.location.origin.length) || '/pulse'
                    : redirect;
                navigate(path, { replace: true });
            }
        } catch { setError('Connection error'); } finally { setBusy(false); }
    };

    const stepNo = step === 'phone' ? 1 : step === 'code' ? 2 : 3;

    return (
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--blanc-bg, #F1F1F0)', fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif', padding: 16,
        }}>
            <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--blanc-ink-3, #7d8796)', fontWeight: 500 }}>Step {stepNo} of 3</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                        {[1, 2, 3].map(n => (
                            <span key={n} style={{ width: 7, height: 7, borderRadius: 99, background: n <= stepNo ? 'var(--blanc-job, #2f63d8)' : 'rgba(25,25,25,0.18)' }} />
                        ))}
                    </span>
                </div>

                {step === 'phone' && (
                    <form onSubmit={e => { e.preventDefault(); sendCode(); }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, fontWeight: 600, margin: 0, color: 'var(--blanc-ink-1, #202734)' }}>Verify your phone</h1>
                        <div>
                            <label style={labelStyle}>Mobile phone</label>
                            <input style={inputStyle} type="tel" inputMode="tel" value={phone} autoFocus required placeholder="(617) 555-0142" autoComplete="tel" onChange={e => setPhone(formatUSPhone(e.target.value))} />
                            <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--blanc-ink-3, #7d8796)', display: 'flex', gap: 6, alignItems: 'center' }}>
                                <ShieldCheck size={14} /> Used to confirm sign-ins with a 6-digit SMS code
                            </p>
                        </div>
                        {error && <div role="alert" style={{ color: 'var(--blanc-danger, #d44d3c)', fontSize: 13 }}>{error}</div>}
                        <button type="submit" disabled={busy} aria-busy={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                            {busy ? <Loader2 size={17} className="animate-spin" /> : <>Send code <ArrowRight size={16} /></>}
                        </button>
                    </form>
                )}

                {step === 'code' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <div>
                            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, fontWeight: 600, margin: '0 0 6px', color: 'var(--blanc-ink-1, #202734)' }}>Enter your code</h1>
                            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--blanc-ink-3, #7d8796)' }}>We texted a 6-digit code to <strong style={{ color: 'var(--blanc-ink-1, #202734)', fontWeight: 500 }}>{phone}</strong>.</p>
                        </div>
                        <OtpCells value={code} onChange={onCodeChange} disabled={busy} />
                        <div aria-live="polite" style={{ minHeight: 18, fontSize: 13, color: error ? 'var(--blanc-danger, #d44d3c)' : 'var(--blanc-ink-3, #7d8796)' }}>
                            {busy ? 'Verifying…' : error || 'Paste works too — submits automatically at 6 digits.'}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <button type="button" onClick={() => { setStep('phone'); setCode(''); setError(null); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blanc-ink-2, #536070)', fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                                <ArrowLeft size={14} /> Change number
                            </button>
                            <button type="button" disabled={resendIn > 0} onClick={sendCode}
                                style={{ background: 'none', border: 'none', cursor: resendIn > 0 ? 'default' : 'pointer', color: resendIn > 0 ? 'var(--blanc-ink-3, #7d8796)' : 'var(--blanc-job, #2f63d8)', fontSize: 13, fontWeight: 600 }}>
                                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                            </button>
                        </div>
                    </div>
                )}

                {step === 'company' && (
                    <form onSubmit={createCompany} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontSize: 22, fontWeight: 600, margin: 0, color: 'var(--blanc-ink-1, #202734)' }}>Your company</h1>
                        <div>
                            <label style={labelStyle}>Company name</label>
                            <input style={inputStyle} value={companyName} autoFocus required minLength={2} placeholder="Acme Appliance Repair" onChange={e => setCompanyName(e.target.value)} />
                        </div>
                        <div style={{ position: 'relative' }}>
                            <label style={labelStyle}>City or ZIP code</label>
                            <input style={inputStyle} value={picked ? picked.description : placeQuery} required placeholder="Boston or 02101"
                                role="combobox" aria-expanded={!picked && suggestions.length > 0} aria-autocomplete="list"
                                onChange={e => { setPicked(null); setPlaceQuery(e.target.value); }} />
                            {!picked && suggestions.length > 0 && (
                                <div role="listbox" style={{
                                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: '#fff',
                                    border: '1px solid var(--blanc-line, var(--blanc-line))', borderRadius: 10, marginTop: 4, overflow: 'hidden',
                                }}>
                                    {suggestions.map(sg => (
                                        <button key={sg.place_id} type="button" role="option" aria-selected={false}
                                            onClick={() => { setPicked(sg); setSuggestions([]); }}
                                            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, textAlign: 'left', color: 'var(--blanc-ink-1, #202734)' }}>
                                            <MapPin size={14} style={{ color: 'var(--blanc-ink-3, #7d8796)' }} />{sg.description}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--blanc-ink-3, #7d8796)' }}>We'll set your timezone and service area from this.</p>
                        </div>
                        {error && <div role="alert" style={{ color: 'var(--blanc-danger, #d44d3c)', fontSize: 13 }}>{error}</div>}
                        <button type="submit" disabled={busy || !companyName.trim()} aria-busy={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                            {busy ? <Loader2 size={17} className="animate-spin" /> : <>Open my workspace <ArrowRight size={16} /></>}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

export default OnboardingPage;

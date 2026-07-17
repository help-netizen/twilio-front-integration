/**
 * TwoFactorGate.tsx — AUTH-2FA-GATE.
 *
 * Global overlay that re-verifies the user's phone when the backend demands it
 * (401 PHONE_VERIFICATION_REQUIRED — trusted-device cookie expired or a new
 * device). Mounted once at app root. Sends a code to the user's ALREADY-stored
 * phone (no phone re-entry; shows a masked hint), verifies it, trusts the
 * device (30-day cookie), then unblocks every waiting request. No re-login.
 */
import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { getAuthHeaders } from '../../auth/AuthProvider';
import { subscribeTwoFactor, completeTwoFactor } from '../../services/twoFactorGate';

// Direct fetch with auth headers — the /api/auth/* endpoints are 2FA-exempt, so
// they never re-trigger the gate (no recursion through authedFetch).
function authFetch(path: string, body?: unknown): Promise<Response> {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: body ? JSON.stringify(body) : undefined,
    });
}

const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: 'rgba(244,241,234,0.86)', backdropFilter: 'blur(3px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const card: React.CSSProperties = {
    width: 420, maxWidth: '100%', background: '#fffdf9',
    border: '1px solid rgba(117,106,89,0.18)', borderRadius: 22,
    padding: '28px 28px 24px', boxShadow: '0 20px 60px rgba(60,54,44,0.12)',
};
const input: React.CSSProperties = {
    width: '100%', height: 46, borderRadius: 12, padding: '0 14px',
    border: '1px solid rgba(117,106,89,0.28)', fontSize: 20, letterSpacing: '0.5em',
    textAlign: 'center', fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box',
};

export default function TwoFactorGate() {
    const [active, setActive] = useState(false);
    const [phoneHint, setPhoneHint] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendIn, setResendIn] = useState(0);
    const codeRef = useRef<HTMLInputElement>(null);

    // Show/hide when the gate is required.
    useEffect(() => subscribeTwoFactor((on) => {
        setActive(on);
        if (on) { setCode(''); setError(null); }
    }), []);

    // Auto-send a code as soon as the gate opens.
    useEffect(() => { if (active) void send(); /* eslint-disable-next-line */ }, [active]);

    // Resend countdown.
    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
        return () => clearInterval(t);
    }, [resendIn]);

    async function send() {
        setError(null); setBusy(true);
        try {
            const r = await authFetch('/api/auth/otp/send');
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.message || 'Could not send the code');
            setPhoneHint(j.phone_hint || 'your phone');
            setResendIn(j.resend_after_sec || 30);
            setTimeout(() => codeRef.current?.focus(), 50);
        } catch (e: any) { setError(e.message); }
        finally { setBusy(false); }
    }

    async function verify(value: string) {
        setError(null); setBusy(true);
        try {
            const vr = await authFetch('/api/auth/otp/verify', { code: value });
            const vj = await vr.json().catch(() => ({}));
            if (!vr.ok) throw new Error(vj.message || 'Invalid code');
            const tr = await authFetch('/api/auth/trust-device', { otp_token: vj.otp_token });
            const tj = await tr.json().catch(() => ({}));
            if (!tr.ok) throw new Error(tj.message || 'Could not confirm this device');
            completeTwoFactor();           // unblock waiters; the failed request retries
        } catch (e: any) {
            setError(e.message); setCode('');
            setTimeout(() => codeRef.current?.focus(), 50);
        } finally { setBusy(false); }
    }

    function onCodeChange(v: string) {
        const digits = v.replace(/\D/g, '').slice(0, 6);
        setCode(digits);
        if (digits.length === 6 && !busy) void verify(digits);
    }

    if (!active) return null;

    return (
        <div style={overlay}>
            <div style={card}>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'Manrope, sans-serif', color: '#2c2722' }}>Confirm it's you</div>
                <p style={{ margin: '8px 0 18px', fontSize: 14, color: 'rgba(60,54,44,0.65)', display: 'flex', gap: 7, alignItems: 'center' }}>
                    <ShieldCheck size={15} /> For your security, enter the 6-digit code we texted to {phoneHint || 'your phone'}.
                </p>
                <input ref={codeRef} style={input} inputMode="numeric" autoComplete="one-time-code"
                    autoFocus value={code} onChange={(e) => onCodeChange(e.target.value)} placeholder="••••••" />
                {error && <div style={{ color: '#b3422f', fontSize: 13, marginTop: 10 }}>{error}</div>}
                {busy && <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}><Loader2 size={18} className="animate-spin" /></div>}
                <button type="button" disabled={resendIn > 0 || busy} onClick={() => void send()}
                    style={{ marginTop: 16, background: 'none', border: 'none', cursor: resendIn > 0 ? 'default' : 'pointer', color: resendIn > 0 ? 'rgba(60,54,44,0.4)' : '#3c362c', fontSize: 13, fontWeight: 600 }}>
                    {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
                </button>
            </div>
        </div>
    );
}

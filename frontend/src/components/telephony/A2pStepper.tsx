/**
 * A2pStepper — A2P 10DLC registration as a readable 3-step flow (099).
 *
 * Replaces the single status pill + empty-body POST link. Steps map to the real
 * backend state machine (company_a2p_registrations.status):
 *   1 Business verification → POST /a2p/register      (not_started → brand_pending)
 *   2 Messaging campaign    → POST /a2p/campaign       (brand approved → campaign_pending)
 *   3 SMS enabled           → status === 'approved'
 * GET /a2p auto-refreshes from Twilio, so "Check status" advances pending steps.
 */
import { Loader2, Check, ShieldAlert, MessageSquareText, RefreshCw } from 'lucide-react';

const LINE = 'var(--blanc-line, rgba(117,106,89,0.18))';
const INK1 = 'var(--blanc-ink-1, #202734)';
const INK2 = 'var(--blanc-ink-2, #536070)';
const INK3 = 'var(--blanc-ink-3, #7d8796)';
const JOB = 'var(--blanc-job, #2f63d8)';
const OK = 'var(--blanc-success, #1b8b63)';
const WARN = 'var(--blanc-warning, #b26a1d)';
const DANGER = 'var(--blanc-danger, #d44d3c)';

export interface A2pRegistration {
    status: 'not_started' | 'brand_pending' | 'brand_failed' | 'campaign_pending' | 'campaign_failed' | 'approved';
    brand_status?: string;
    campaign_status?: string;
    last_error?: string;
}

const BIZ_FIELDS: Array<[string, string, boolean?]> = [
    ['legal_name', 'Legal business name', true],
    ['ein', 'EIN (XX-XXXXXXX)'],
    ['website', 'Website', true],
    ['address_street', 'Street address', true],
    ['address_city', 'City'],
    ['address_state', 'State (e.g. MA)'],
    ['address_zip', 'ZIP'],
    ['contact_first_name', 'Contact first name'],
    ['contact_last_name', 'Contact last name'],
    ['contact_email', 'Contact email'],
    ['contact_phone', 'Contact phone (+1…)', true],
];

type StepState = 'complete' | 'active' | 'pending' | 'failed' | 'locked';

const STATE_BADGE: Record<StepState, { label: string; color: string; bg: string }> = {
    complete: { label: 'Done', color: OK, bg: 'rgba(27,139,99,0.12)' },
    active: { label: 'Action needed', color: JOB, bg: 'rgba(47,99,216,0.12)' },
    pending: { label: 'In review', color: WARN, bg: 'rgba(178,106,29,0.12)' },
    failed: { label: 'Failed', color: DANGER, bg: 'rgba(212,77,60,0.12)' },
    locked: { label: 'Not yet', color: INK3, bg: 'rgba(117,106,89,0.08)' },
};

interface A2pStepperProps {
    reg: A2pRegistration | null;
    biz: Record<string, string>;
    setBiz: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
    busy: boolean;
    error: string | null;
    onRegister: () => void;
    onCreateCampaign: () => void;
    onRefresh: () => void;
    refreshing?: boolean;
}

function StepShell({ index, title, state, children }: { index: number; title: string; state: StepState; children?: React.ReactNode }) {
    const badge = STATE_BADGE[state];
    const done = state === 'complete';
    return (
        <div style={{ display: 'flex', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{
                    width: 28, height: 28, borderRadius: 999, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700,
                    background: done ? OK : state === 'locked' ? 'rgba(117,106,89,0.08)' : 'rgba(47,99,216,0.12)',
                    color: done ? '#fff' : state === 'locked' ? INK3 : JOB,
                }}>{done ? <Check size={15} /> : index}</div>
                {index < 3 && <div style={{ width: 2, flex: 1, minHeight: 14, background: LINE, marginTop: 4 }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 }}>
                    <span style={{ fontWeight: 600, fontSize: 14.5, color: INK1 }}>{title}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 999, color: badge.color, background: badge.bg }}>{badge.label}</span>
                </div>
                {children && <div style={{ marginTop: 10 }}>{children}</div>}
            </div>
        </div>
    );
}

export function A2pStepper({ reg, biz, setBiz, busy, error, onRegister, onCreateCampaign, onRefresh, refreshing }: A2pStepperProps) {
    const status = reg?.status || 'not_started';
    const brandApproved = reg?.brand_status === 'APPROVED' || status === 'campaign_pending' || status === 'campaign_failed' || status === 'approved';

    // Derive each step's state from the backend status.
    const step1: StepState = status === 'brand_failed' ? 'failed'
        : status === 'not_started' ? 'active'
            : status === 'brand_pending' && !brandApproved ? 'pending'
                : 'complete';
    const step2: StepState = status === 'approved' ? 'complete'
        : status === 'campaign_pending' ? 'pending'
            : status === 'campaign_failed' ? 'failed'
                : brandApproved ? 'active'
                    : 'locked';
    const step3: StepState = status === 'approved' ? 'complete' : 'locked';

    const showForm = step1 === 'active' || step1 === 'failed';
    const showCampaign = step2 === 'active' || step2 === 'failed';
    const isPending = status === 'brand_pending' || status === 'campaign_pending';

    const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 12px', border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13, background: 'var(--blanc-surface-strong, #fffdf9)', color: INK1, boxSizing: 'border-box' };
    const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: JOB, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 };

    return (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 16, padding: '18px 20px', background: 'var(--blanc-surface-strong, #fffdf9)', marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 15, color: INK1 }}>
                        <MessageSquareText size={17} style={{ color: JOB }} /> SMS compliance (A2P 10DLC)
                    </div>
                    <div style={{ fontSize: 12.5, color: INK3, marginTop: 3 }}>
                        US carriers require a one-time business registration before they stop filtering your texts.
                    </div>
                </div>
                {isPending && (
                    <button onClick={onRefresh} disabled={refreshing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: 'transparent', border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, color: INK2, cursor: 'pointer' }}>
                        <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Check status
                    </button>
                )}
            </div>

            {status === 'approved' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: 'rgba(27,139,99,0.1)', color: OK, fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
                    <Check size={15} /> SMS is fully enabled — your numbers send registered A2P traffic.
                </div>
            )}

            <StepShell index={1} title="Business verification" state={step1}>
                {step1 === 'pending' && <div style={{ fontSize: 13, color: INK2 }}>Brand registration is in review — usually minutes to a few days.</div>}
                {showForm && (
                    <div>
                        {step1 === 'failed' && reg?.last_error && (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: DANGER, marginBottom: 12 }}>
                                <ShieldAlert size={14} style={{ marginTop: 1, flexShrink: 0 }} /><span>{reg.last_error}</span>
                            </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            {BIZ_FIELDS.map(([key, label, full]) => (
                                <div key={key} style={{ gridColumn: full ? '1 / -1' : undefined }}>
                                    <label style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: INK3, display: 'block', marginBottom: 4 }}>{label}</label>
                                    <input value={biz[key] || ''} onChange={e => setBiz(prev => ({ ...prev, [key]: e.target.value }))} style={inputStyle} />
                                </div>
                            ))}
                        </div>
                        {error && <div style={{ marginTop: 12, fontSize: 12.5, color: DANGER }}>{error}</div>}
                        <button onClick={onRegister} disabled={busy} style={{ ...primaryBtn, marginTop: 14 }}>
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {step1 === 'failed' ? 'Resubmit registration' : 'Submit registration'}
                        </button>
                    </div>
                )}
            </StepShell>

            <StepShell index={2} title="Messaging campaign" state={step2}>
                {step2 === 'locked' && <div style={{ fontSize: 13, color: INK3 }}>Unlocks once your business is verified.</div>}
                {step2 === 'pending' && <div style={{ fontSize: 13, color: INK2 }}>Campaign submitted — in carrier review.</div>}
                {showCampaign && (
                    <div>
                        <div style={{ fontSize: 13, color: INK2, lineHeight: 1.5 }}>
                            Registers a customer-care messaging campaign for your verified brand. This links your numbers to a shared messaging service so texts deliver as registered traffic.
                        </div>
                        {step2 === 'failed' && reg?.last_error && (
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: DANGER, marginTop: 10 }}>
                                <ShieldAlert size={14} style={{ marginTop: 1, flexShrink: 0 }} /><span>{reg.last_error}</span>
                            </div>
                        )}
                        {error && <div style={{ marginTop: 10, fontSize: 12.5, color: DANGER }}>{error}</div>}
                        <button onClick={onCreateCampaign} disabled={busy} style={{ ...primaryBtn, marginTop: 12 }}>
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />} {step2 === 'failed' ? 'Resubmit campaign' : 'Create messaging campaign'}
                        </button>
                    </div>
                )}
            </StepShell>

            <StepShell index={3} title="SMS enabled" state={step3}>
                {step3 !== 'complete' && <div style={{ fontSize: 13, color: INK3 }}>Your numbers send fully-registered SMS once both steps above are approved.</div>}
            </StepShell>
        </div>
    );
}

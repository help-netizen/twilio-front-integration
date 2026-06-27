import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, AlertCircle, Building2, ImageOff } from 'lucide-react';
import { Button } from '../components/ui/button';
import { FloatingField } from '../components/ui/floating-field';
import { CompanyBaseAddress } from '../components/settings/CompanyBaseAddress';
import {
    companyProfileApi,
    type CompanyProfile,
    type CompanyProfilePatch,
} from '../services/companyProfileApi';

const sectionCard = { background: 'rgba(117,106,89,0.04)', borderRadius: 16, padding: '20px 22px' } as const;

function Eyebrow({ children }: { children: React.ReactNode }) {
    return (
        <div
            className="blanc-eyebrow"
            style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--blanc-ink-3)' }}
        >
            {children}
        </div>
    );
}

/** Return the trimmed fields whose value changed vs. `initial` (untouched fields are skipped). */
function diffPatch<T extends Record<string, string>>(current: T, initial: T): Partial<Record<keyof T, string>> {
    const out: Partial<Record<keyof T, string>> = {};
    (Object.keys(current) as (keyof T)[]).forEach(key => {
        const next = current[key].trim();
        if (next !== (initial[key] ?? '').trim()) out[key] = next;
    });
    return out;
}

// ── Identity ──────────────────────────────────────────────────────────────

type IdentityForm = { name: string; contact_email: string; contact_phone: string; billing_email: string };

function identityFrom(p: CompanyProfile): IdentityForm {
    return {
        name: p.name ?? '',
        contact_email: p.contact_email ?? '',
        contact_phone: p.contact_phone ?? '',
        billing_email: p.billing_email ?? '',
    };
}

function IdentitySection({ profile, onSaved }: { profile: CompanyProfile; onSaved: (p: CompanyProfile) => void }) {
    const [form, setForm] = useState<IdentityForm>(() => identityFrom(profile));
    const [saving, setSaving] = useState(false);
    const initial = useRef<IdentityForm>(identityFrom(profile));

    // Re-seed if the upstream profile changes (e.g. after a logo upload refetch).
    useEffect(() => {
        const next = identityFrom(profile);
        initial.current = next;
        setForm(next);
    }, [profile]);

    const set = (k: keyof IdentityForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setForm(f => ({ ...f, [k]: e.target.value }));

    const dirty = Object.keys(diffPatch(form, initial.current)).length > 0;

    const save = async () => {
        if (!form.name.trim()) { toast.error('Company name is required'); return; }
        const patch = diffPatch(form, initial.current) as CompanyProfilePatch;
        if (Object.keys(patch).length === 0) return;
        setSaving(true);
        try {
            const saved = await companyProfileApi.update(patch);
            onSaved(saved);
            toast.success('Company details saved');
        } catch (e: any) { toast.error(e.message || 'Failed to save company details'); }
        finally { setSaving(false); }
    };

    return (
        <section style={sectionCard}>
            <Eyebrow>Identity</Eyebrow>
            <p className="text-[13px] mt-1 mb-4" style={{ color: 'var(--blanc-ink-3)' }}>
                Your company name appears in the customer “on the way” text and on every invoice and estimate.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                <FloatingField label="Company name" value={form.name} onChange={set('name')} containerClassName="sm:col-span-2" />
                <FloatingField label="Contact email" type="email" inputMode="email" value={form.contact_email} onChange={set('contact_email')} />
                <FloatingField label="Contact phone" type="tel" inputMode="tel" value={form.contact_phone} onChange={set('contact_phone')} />
                <FloatingField label="Billing email" type="email" inputMode="email" value={form.billing_email} onChange={set('billing_email')} containerClassName="sm:col-span-2" />
            </div>
            <div className="mt-4 flex items-center gap-3">
                <Button onClick={save} disabled={saving || !dirty}>
                    {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
                </Button>
                {!form.name.trim() && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Company name is required.</span>}
            </div>
        </section>
    );
}

// ── Logo ──────────────────────────────────────────────────────────────────

function LogoSection({ logoUrl, onUploaded }: { logoUrl: string | null; onUploaded: () => void }) {
    const [uploading, setUploading] = useState(false);
    const fileInput = useRef<HTMLInputElement | null>(null);

    const onPick = async (file?: File) => {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast.error('Logo must be 5MB or smaller'); return; }
        setUploading(true);
        try {
            await companyProfileApi.uploadLogo(file);
            toast.success('Logo updated');
            onUploaded();
        } catch (e: any) { toast.error(e.message || 'Upload failed'); }
        finally {
            setUploading(false);
            if (fileInput.current) fileInput.current.value = ''; // allow re-picking the same file
        }
    };

    return (
        <section style={sectionCard}>
            <Eyebrow>Logo</Eyebrow>
            <p className="text-[13px] mt-1 mb-4" style={{ color: 'var(--blanc-ink-3)' }}>
                Shown on invoices and estimates. A square or wide PNG works best, up to 5MB.
            </p>
            <div className="flex items-center gap-4">
                <div
                    className="h-16 w-16 rounded-xl flex items-center justify-center overflow-hidden shrink-0 border"
                    style={{ background: 'var(--blanc-panel-surface, #fffdf9)', borderColor: 'var(--blanc-line)' }}
                >
                    {logoUrl
                        ? <img src={logoUrl} alt="Company logo" className="h-full w-full object-contain" />
                        : <ImageOff className="h-6 w-6" style={{ color: 'var(--blanc-ink-3)' }} />}
                </div>
                <div className="min-w-0">
                    <input
                        ref={el => { fileInput.current = el; }}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={e => onPick(e.target.files?.[0])}
                    />
                    <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
                        {uploading
                            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading…</>
                            : logoUrl ? 'Replace logo' : 'Upload logo'}
                    </Button>
                    {!logoUrl && <div className="text-xs mt-1.5" style={{ color: 'var(--blanc-ink-3)' }}>No logo yet</div>}
                </div>
            </div>
        </section>
    );
}

// ── Payment / bank details ──────────────────────────────────────────────────

type PaymentForm = {
    bank_name: string; account_name: string; account_number: string;
    routing_number: string; swift: string; instructions: string;
};

function paymentFrom(p: CompanyProfile): PaymentForm {
    return {
        bank_name: p.payment.bank_name ?? '',
        account_name: p.payment.account_name ?? '',
        account_number: p.payment.account_number ?? '',
        routing_number: p.payment.routing_number ?? '',
        swift: p.payment.swift ?? '',
        instructions: p.payment.instructions ?? '',
    };
}

// Map local form keys → PATCH body keys (payment_* prefix).
const PAYMENT_FIELD: Record<keyof PaymentForm, keyof CompanyProfilePatch> = {
    bank_name: 'payment_bank_name',
    account_name: 'payment_account_name',
    account_number: 'payment_account_number',
    routing_number: 'payment_routing_number',
    swift: 'payment_swift',
    instructions: 'payment_instructions',
};

function PaymentSection({ profile, onSaved }: { profile: CompanyProfile; onSaved: (p: CompanyProfile) => void }) {
    const [form, setForm] = useState<PaymentForm>(() => paymentFrom(profile));
    const [saving, setSaving] = useState(false);
    const initial = useRef<PaymentForm>(paymentFrom(profile));

    useEffect(() => {
        const next = paymentFrom(profile);
        initial.current = next;
        setForm(next);
    }, [profile]);

    const set = (k: keyof PaymentForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setForm(f => ({ ...f, [k]: e.target.value }));

    const localDiff = diffPatch(form, initial.current);
    const dirty = Object.keys(localDiff).length > 0;

    const save = async () => {
        if (!dirty) return;
        const patch: CompanyProfilePatch = {};
        for (const [localKey, value] of Object.entries(localDiff)) {
            patch[PAYMENT_FIELD[localKey as keyof PaymentForm]] = value;
        }
        setSaving(true);
        try {
            const saved = await companyProfileApi.update(patch);
            onSaved(saved);
            toast.success('Payment details saved');
        } catch (e: any) { toast.error(e.message || 'Failed to save payment details'); }
        finally { setSaving(false); }
    };

    return (
        <section style={sectionCard}>
            <Eyebrow>Payment / bank details</Eyebrow>
            <p className="text-[13px] mt-1 mb-4" style={{ color: 'var(--blanc-ink-3)' }}>
                These appear on invoices and estimates so customers can pay by direct bank transfer.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                <FloatingField label="Bank name" value={form.bank_name} onChange={set('bank_name')} />
                <FloatingField label="Account name" value={form.account_name} onChange={set('account_name')} />
                <FloatingField label="Account number" value={form.account_number} onChange={set('account_number')} />
                <FloatingField label="Routing number" value={form.routing_number} onChange={set('routing_number')} />
                <FloatingField label="SWIFT / BIC (optional)" value={form.swift} onChange={set('swift')} containerClassName="sm:col-span-2" />
                <FloatingField label="Payment instructions" textarea rows={3} value={form.instructions} onChange={set('instructions')} containerClassName="sm:col-span-2" />
            </div>
            <div className="mt-4">
                <Button onClick={save} disabled={saving || !dirty}>
                    {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
                </Button>
            </div>
        </section>
    );
}

// ── Page ────────────────────────────────────────────────────────────────────

/**
 * Settings → Company. Full company profile editor: identity (name/contact/billing),
 * logo, base address, and direct-transfer bank details. The name + bank details + logo
 * surface on the customer "on the way" SMS and on invoices/estimates.
 */
export default function CompanySettingsPage() {
    const navigate = useNavigate();
    const qc = useQueryClient();

    const { data: profile, isLoading, isError, error } = useQuery({
        queryKey: ['company-profile'],
        queryFn: () => companyProfileApi.get(),
    });

    const applySaved = (p: CompanyProfile) => qc.setQueryData(['company-profile'], p);
    const refetch = () => qc.invalidateQueries({ queryKey: ['company-profile'] });

    return (
        <div className="max-w-2xl mx-auto px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            <button onClick={() => navigate('/settings/integrations')} className="flex items-center gap-1.5 text-sm mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                <ArrowLeft className="h-4 w-4" /> Settings
            </button>

            <div className="flex items-center gap-3 mb-1">
                <div className="flex items-center justify-center h-11 w-11 rounded-xl shrink-0" style={{ background: 'rgba(117,106,89,0.08)' }}>
                    <Building2 className="h-5 w-5" style={{ color: 'var(--blanc-ink-2)' }} />
                </div>
                <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, inherit)' }}>Company profile</h2>
            </div>
            <p className="text-sm mt-1 mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                Your business identity — used on invoices, estimates, and customer messages.
            </p>

            {isLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : isError || !profile ? (
                <div style={sectionCard}>
                    <p className="text-sm flex items-start gap-2" style={{ color: 'var(--blanc-warning)' }}>
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                        {(error as Error | undefined)?.message || 'Could not load the company profile.'}
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>Try again</Button>
                </div>
            ) : (
                <div className="space-y-6">
                    <IdentitySection profile={profile} onSaved={applySaved} />
                    <LogoSection logoUrl={profile.logo_url} onUploaded={refetch} />
                    <CompanyBaseAddress title="Company address" />
                    <PaymentSection profile={profile} onSaved={applySaved} />
                </div>
            )}
        </div>
    );
}

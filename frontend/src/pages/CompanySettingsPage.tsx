import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, AlertCircle, ImageOff } from 'lucide-react';
import { Button } from '../components/ui/button';
import { FloatingField } from '../components/ui/floating-field';
import { CompanyBaseAddress } from '../components/settings/CompanyBaseAddress';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { SettingsSection } from '../components/settings/SettingsSection';
import {
    companyProfileApi,
    type CompanyProfile,
    type CompanyProfilePatch,
} from '../services/companyProfileApi';

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
        <SettingsSection
            title="Identity"
            description="Your company name appears in the customer “on the way” text and on every invoice and estimate."
            footer={
                <>
                    {!form.name.trim() && <span className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Company name is required.</span>}
                    <Button onClick={save} disabled={saving || !dirty}>
                        {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
                    </Button>
                </>
            }
        >
            <div className="grid gap-3 sm:grid-cols-2">
                <FloatingField label="Company name" value={form.name} onChange={set('name')} containerClassName="sm:col-span-2" />
                <FloatingField label="Contact email" type="email" inputMode="email" value={form.contact_email} onChange={set('contact_email')} />
                <FloatingField label="Contact phone" type="tel" inputMode="tel" value={form.contact_phone} onChange={set('contact_phone')} />
                <FloatingField label="Billing email" type="email" inputMode="email" value={form.billing_email} onChange={set('billing_email')} containerClassName="sm:col-span-2" />
            </div>
        </SettingsSection>
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
        <SettingsSection
            title="Logo"
            description="Shown on invoices and estimates. A square or wide PNG works best, up to 5MB."
        >
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
        </SettingsSection>
    );
}

// ── Page ────────────────────────────────────────────────────────────────────

/**
 * Settings → Business. Company identity, logo, and base address. Direct-transfer
 * details moved to Billing & payments in SETTINGS-IA-001.
 */
export default function CompanySettingsPage() {
    const qc = useQueryClient();

    const { data: profile, isLoading, isError, error } = useQuery({
        queryKey: ['company-profile'],
        queryFn: () => companyProfileApi.get(),
    });

    const applySaved = (p: CompanyProfile) => qc.setQueryData(['company-profile'], p);
    const refetch = () => qc.invalidateQueries({ queryKey: ['company-profile'] });

    return (
        <SettingsPageShell
            backTo="/settings/business"
            backLabel="Settings"
            title="Business profile"
            description="Your business identity — used on invoices, estimates, and customer messages."
        >
            {isLoading ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : isError || !profile ? (
                <SettingsSection>
                    <p className="text-sm flex items-start gap-2" style={{ color: 'var(--blanc-warning)' }}>
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                        {(error as Error | undefined)?.message || 'Could not load the company profile.'}
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>Try again</Button>
                </SettingsSection>
            ) : (
                <>
                    <IdentitySection profile={profile} onSaved={applySaved} />
                    <LogoSection logoUrl={profile.logo_url} onUploaded={refetch} />
                    <CompanyBaseAddress title="Company address" />
                </>
            )}
        </SettingsPageShell>
    );
}

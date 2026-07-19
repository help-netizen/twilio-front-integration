import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
    companyProfileApi,
    type CompanyProfile,
    type CompanyProfilePatch,
} from '../../services/companyProfileApi';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { SettingsSection } from './SettingsSection';

type PaymentForm = {
    bank_name: string;
    account_name: string;
    account_number: string;
    routing_number: string;
    swift: string;
    instructions: string;
};

function paymentFrom(profile: CompanyProfile): PaymentForm {
    return {
        bank_name: profile.payment.bank_name ?? '',
        account_name: profile.payment.account_name ?? '',
        account_number: profile.payment.account_number ?? '',
        routing_number: profile.payment.routing_number ?? '',
        swift: profile.payment.swift ?? '',
        instructions: profile.payment.instructions ?? '',
    };
}

const PAYMENT_FIELD: Record<keyof PaymentForm, keyof CompanyProfilePatch> = {
    bank_name: 'payment_bank_name',
    account_name: 'payment_account_name',
    account_number: 'payment_account_number',
    routing_number: 'payment_routing_number',
    swift: 'payment_swift',
    instructions: 'payment_instructions',
};

export function BankTransferDetails({
    profile,
    onSaved,
}: {
    profile: CompanyProfile;
    onSaved: (profile: CompanyProfile) => void;
}) {
    const [form, setForm] = useState<PaymentForm>(() => paymentFrom(profile));
    const [saving, setSaving] = useState(false);
    const initial = useRef<PaymentForm>(paymentFrom(profile));

    useEffect(() => {
        const next = paymentFrom(profile);
        initial.current = next;
        setForm(next);
    }, [profile]);

    const set = (key: keyof PaymentForm) => (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setForm(current => ({ ...current, [key]: event.target.value }));

    const changes = (Object.keys(form) as (keyof PaymentForm)[]).filter(key => (
        form[key].trim() !== initial.current[key].trim()
    ));

    const save = async () => {
        if (changes.length === 0) return;
        const patch: CompanyProfilePatch = {};
        changes.forEach(key => {
            patch[PAYMENT_FIELD[key]] = form[key].trim();
        });
        setSaving(true);
        try {
            const saved = await companyProfileApi.update(patch);
            onSaved(saved);
            toast.success('Bank transfer details saved');
        } catch (error: any) {
            toast.error(error.message || 'Failed to save bank transfer details');
        } finally {
            setSaving(false);
        }
    };

    return (
        <SettingsSection
            title="Bank details"
            description="These appear on invoices and estimates so customers can pay by direct bank transfer."
            footer={
                <Button onClick={save} disabled={saving || changes.length === 0}>
                    {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Save
                </Button>
            }
        >
            <div className="grid gap-3.5 sm:grid-cols-2">
                <FloatingField label="Bank name" value={form.bank_name} onChange={set('bank_name')} />
                <FloatingField label="Account name" value={form.account_name} onChange={set('account_name')} />
                <FloatingField label="Account number" value={form.account_number} onChange={set('account_number')} />
                <FloatingField label="Routing number" value={form.routing_number} onChange={set('routing_number')} />
                <FloatingField label="SWIFT / BIC (optional)" value={form.swift} onChange={set('swift')} containerClassName="sm:col-span-2" />
                <FloatingField label="Payment instructions" textarea rows={3} value={form.instructions} onChange={set('instructions')} containerClassName="sm:col-span-2" />
            </div>
        </SettingsSection>
    );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthz } from '../../hooks/useAuthz';
import { todayInTZ } from '../../utils/companyTime';
import { authedFetch } from '../../services/apiClient';
import { Button } from '../ui/button';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { PhoneInput, isValidUSPhone, toE164 } from '../ui/PhoneInput';
import { SelectItem } from '../ui/select';
import {
    PORTING_UNAVAILABLE_NOTICE,
    TERMINAL_PORT_IN_STATUSES,
    portInStatusLabel,
} from './portInStatus';

export interface PortInRequest {
    id: string;
    phone_number: string;
    customer_name: string | null;
    status: string;
    twilio_status: string | null;
    signature_request_url: string | null;
    target_port_in_date: string | null;
    created_at: string;
    updated_at: string;
    /** Available only for the request created in this browser session. */
    representative_email?: string;
}

interface PortInPanelProps {
    initialRequests?: PortInRequest[];
    statusOnly?: boolean;
    onGetNewNumber?: () => void;
    onRequestsChange?: (requests: PortInRequest[]) => void;
}

interface PortInForm {
    customer_name: string;
    customer_type: 'Individual' | 'Business';
    account_number: string;
    pin: string;
    account_telephone_number: string;
    authorized_representative: string;
    authorized_representative_email: string;
    address_street: string;
    address_street2: string;
    address_city: string;
    address_state: string;
    address_zip: string;
    address_country: string;
    target_port_in_date: string;
}

const EMPTY_FORM: PortInForm = {
    customer_name: '',
    customer_type: 'Individual',
    account_number: '',
    pin: '',
    account_telephone_number: '',
    authorized_representative: '',
    authorized_representative_email: '',
    address_street: '',
    address_street2: '',
    address_city: '',
    address_state: '',
    address_zip: '',
    address_country: 'USA',
    target_port_in_date: '',
};

function addDays(dateString: string, days: number): string {
    const date = new Date(`${dateString}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function formatDateOnly(dateString: string): string {
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(new Date(`${dateString.slice(0, 10)}T00:00:00Z`));
}

function InlineError({ text }: { text: string }) {
    return (
        <div className="flex items-start gap-1.5 text-[13px] text-[var(--blanc-danger)]">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{text}</span>
        </div>
    );
}

function PortInStatusCard({
    request,
    canceling,
    onCancel,
}: {
    request: PortInRequest;
    canceling: boolean;
    onCancel: (request: PortInRequest) => void;
}) {
    const terminal = TERMINAL_PORT_IN_STATUSES.has(request.status);

    return (
        <article className="rounded-xl border border-[var(--blanc-line)] bg-[var(--blanc-surface-strong)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-[var(--blanc-ink-1)]">{request.phone_number}</p>
                    <p className="mt-1 text-[13px] text-[var(--blanc-ink-2)]">{portInStatusLabel(request)}</p>
                    {request.customer_name && (
                        <p className="mt-1 text-xs text-[var(--blanc-ink-3)]">Account: {request.customer_name}</p>
                    )}
                    {request.target_port_in_date && (
                        <p className="mt-1 text-xs text-[var(--blanc-ink-3)]">
                            Requested transfer date: {formatDateOnly(request.target_port_in_date)}
                        </p>
                    )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {request.signature_request_url && !terminal && (
                        <Button asChild size="sm">
                            <a href={request.signature_request_url} target="_blank" rel="noreferrer">
                                Sign authorization <ExternalLink className="size-3.5" />
                            </a>
                        </Button>
                    )}
                    {!terminal && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={canceling}
                            onClick={() => onCancel(request)}
                        >
                            {canceling && <Loader2 className="size-3.5 animate-spin" />}
                            Cancel
                        </Button>
                    )}
                </div>
            </div>
        </article>
    );
}

export function PortInPanel({
    initialRequests = [],
    statusOnly = false,
    onGetNewNumber,
    onRequestsChange,
}: PortInPanelProps) {
    const { company } = useAuthz();
    const [requests, setRequests] = useState<PortInRequest[]>(initialRequests);
    const [loadingRequests, setLoadingRequests] = useState(initialRequests.length === 0);
    const [stage, setStage] = useState<'number' | 'details'>('number');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [checking, setChecking] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [cancelingId, setCancelingId] = useState<string | null>(null);
    const [portabilityError, setPortabilityError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [targetDateError, setTargetDateError] = useState<string | null>(null);
    const [unavailableNotice, setUnavailableNotice] = useState<string | null>(null);
    const [utilityBill, setUtilityBill] = useState<File | null>(null);
    const [form, setForm] = useState<PortInForm>(EMPTY_FORM);
    const requestListRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const timezone = company?.timezone || 'America/New_York';
    const minimumTargetDate = addDays(todayInTZ(timezone), 7);

    const publishRequests = useCallback((next: PortInRequest[]) => {
        setRequests(next);
        onRequestsChange?.(next);
    }, [onRequestsChange]);

    const refreshRequests = useCallback(async () => {
        setLoadingRequests(true);
        try {
            const response = await authedFetch('/api/telephony/port-in');
            const body = await response.json().catch(() => ({}));
            if (response.ok && Array.isArray(body.requests)) publishRequests(body.requests);
        } finally {
            setLoadingRequests(false);
        }
    }, [publishRequests]);

    useEffect(() => {
        void refreshRequests();
    }, [refreshRequests]);

    const setField = <K extends keyof PortInForm>(key: K, value: PortInForm[K]) => {
        setForm(current => ({ ...current, [key]: value }));
        setFormError(null);
        if (key === 'target_port_in_date') setTargetDateError(null);
    };

    const showUnavailable = () => {
        setUnavailableNotice(PORTING_UNAVAILABLE_NOTICE);
        setPortabilityError(null);
    };

    const checkPortability = async () => {
        setPortabilityError(null);
        setUnavailableNotice(null);
        if (!isValidUSPhone(phoneNumber)) {
            setPortabilityError('Enter a complete US phone number.');
            return;
        }

        setChecking(true);
        try {
            const response = await authedFetch('/api/telephony/port-in/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone_number: toE164(phoneNumber) }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (body.code === 'PORTING_UNAVAILABLE' || body.code === 'PORTABILITY_CHECK_FAILED') {
                    showUnavailable();
                } else if (response.status === 403) {
                    setPortabilityError("You don't have permission to manage telephony — ask your administrator.");
                } else {
                    setPortabilityError(body.error || 'Could not check this number — try again.');
                }
                return;
            }
            if (!body.portable) {
                setPortabilityError(body.reason || 'This number cannot be transferred.');
                return;
            }
            setStage('details');
        } catch {
            setPortabilityError('Could not check this number — try again.');
        } finally {
            setChecking(false);
        }
    };

    const selectUtilityBill = (file: File | undefined) => {
        setFormError(null);
        if (!file) {
            setUtilityBill(null);
            return;
        }
        if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) {
            setUtilityBill(null);
            setFormError('Utility bill must be a PDF, JPEG, or PNG.');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            setUtilityBill(null);
            setFormError('Utility bill must be 10 MB or smaller.');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setUtilityBill(file);
    };

    const validateForm = (): boolean => {
        const required: Array<keyof PortInForm> = [
            'customer_name',
            'authorized_representative',
            'authorized_representative_email',
            'address_street',
            'address_city',
            'address_state',
            'address_zip',
            'address_country',
        ];
        if (required.some(key => !form[key].trim())) {
            setFormError('Complete all required carrier and account fields.');
            return false;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.authorized_representative_email)) {
            setFormError('Enter a valid email for the authorized representative.');
            return false;
        }
        if (!utilityBill) {
            setFormError('Add a recent utility bill from your current carrier.');
            return false;
        }
        if (form.target_port_in_date && form.target_port_in_date < minimumTargetDate) {
            setTargetDateError(`Choose ${formatDateOnly(minimumTargetDate)} or later.`);
            return false;
        }
        return true;
    };

    const submitTransfer = async () => {
        setFormError(null);
        setTargetDateError(null);
        setUnavailableNotice(null);
        if (!validateForm() || !utilityBill) return;

        const payload = new FormData();
        payload.append('utility_bill', utilityBill);
        payload.append('phone_number', toE164(phoneNumber));
        Object.entries(form).forEach(([key, value]) => {
            if (value) payload.append(key, value);
        });

        setSubmitting(true);
        try {
            const response = await authedFetch('/api/telephony/port-in', {
                method: 'POST',
                body: payload,
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (body.code === 'TARGET_DATE_TOO_SOON') {
                    setTargetDateError(`Choose ${formatDateOnly(minimumTargetDate)} or later.`);
                    return;
                }
                if (body.code === 'PORTING_UNAVAILABLE') {
                    showUnavailable();
                    await refreshRequests();
                    return;
                }
                if (body.code === 'PORT_ALREADY_REQUESTED') {
                    toast.error(body.error || 'A transfer request already exists for this number.');
                    await refreshRequests();
                    requestListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    return;
                }
                if (body.code === 'NOT_PORTABLE') {
                    setStage('number');
                    setPortabilityError(body.error || 'This number cannot be transferred.');
                    return;
                }
                setFormError(body.error || 'Could not start the transfer — try again.');
                return;
            }

            const created = {
                ...(body.request as PortInRequest),
                representative_email: form.authorized_representative_email,
            };
            publishRequests([created, ...requests.filter(request => request.id !== created.id)]);
            setStage('number');
            setPhoneNumber('');
            setForm(EMPTY_FORM);
            setUtilityBill(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            toast.success('Number transfer started');
            requestListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch {
            setFormError('Could not start the transfer — try again.');
        } finally {
            setSubmitting(false);
        }
    };

    const cancelTransfer = async (request: PortInRequest) => {
        setCancelingId(request.id);
        try {
            const response = await authedFetch(`/api/telephony/port-in/${request.id}`, { method: 'DELETE' });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                toast.error(body.error || 'Could not cancel the transfer');
                return;
            }
            publishRequests(requests.map(current => current.id === request.id ? body.request : current));
            toast.success('Number transfer canceled');
        } catch {
            toast.error('Could not cancel the transfer');
        } finally {
            setCancelingId(null);
        }
    };

    if (statusOnly && loadingRequests && requests.length === 0) {
        return (
            <div className="flex items-center gap-2 text-sm text-[var(--blanc-ink-3)]">
                <Loader2 className="size-4 animate-spin" /> Refreshing transfers…
            </div>
        );
    }

    if (statusOnly && requests.length === 0) return null;

    return (
        <div className="space-y-6">
            {!statusOnly && (
                <p className="text-sm text-[var(--blanc-ink-2)]">
                    We recommend grabbing a new number now — outbound calls keep flowing from it while the transfer completes, so you don't lose customers.{' '}
                    <button
                        type="button"
                        onClick={onGetNewNumber}
                        className="font-medium text-[var(--blanc-accent)] underline-offset-4 hover:underline"
                    >
                        Get a new number
                    </button>
                </p>
            )}

            {unavailableNotice && (
                <div className="rounded-xl bg-[var(--blanc-surface-muted)] p-3.5 text-[13px] text-[var(--blanc-warning)]">
                    {unavailableNotice}
                </div>
            )}

            {requests.length > 0 && (
                <div ref={requestListRef} className="space-y-3.5">
                    {requests.map(request => (
                        <PortInStatusCard
                            key={request.id}
                            request={request}
                            canceling={cancelingId === request.id}
                            onCancel={cancelTransfer}
                        />
                    ))}
                </div>
            )}

            {!statusOnly && stage === 'number' && (
                <div className="space-y-3.5">
                    <PhoneInput
                        id="port-in-phone"
                        label="Your current phone number"
                        value={phoneNumber}
                        onChange={value => {
                            setPhoneNumber(value);
                            setPortabilityError(null);
                            setUnavailableNotice(null);
                        }}
                        disabled={checking}
                    />
                    {portabilityError && (
                        <div className="space-y-2">
                            <InlineError text={portabilityError} />
                            <Button type="button" variant="link" className="h-auto px-0 py-0" onClick={onGetNewNumber}>
                                Get a new number instead
                            </Button>
                        </div>
                    )}
                    <Button type="button" onClick={checkPortability} disabled={checking}>
                        {checking && <Loader2 className="size-4 animate-spin" />}
                        Check if it can move
                    </Button>
                </div>
            )}

            {!statusOnly && stage === 'details' && (
                <div className="space-y-6">
                    <div className="space-y-3.5">
                        <p className="blanc-eyebrow">Current carrier account</p>
                        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                            <FloatingField label="Customer or business name" value={form.customer_name} onChange={event => setField('customer_name', event.target.value)} />
                            <FloatingSelect label="Customer type" value={form.customer_type} onValueChange={value => setField('customer_type', value as PortInForm['customer_type'])}>
                                <SelectItem value="Individual">Individual</SelectItem>
                                <SelectItem value="Business">Business</SelectItem>
                            </FloatingSelect>
                        </div>
                        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                            <FloatingField label="Account number (optional)" value={form.account_number} onChange={event => setField('account_number', event.target.value)} />
                            <FloatingField label="PIN (optional)" value={form.pin} onChange={event => setField('pin', event.target.value)} />
                        </div>
                        <p className="text-xs text-[var(--blanc-ink-3)]">Mobile carriers may require your account number and PIN.</p>
                        <PhoneInput
                            id="port-in-account-phone"
                            label="Account phone number (optional)"
                            value={form.account_telephone_number}
                            onChange={value => setField('account_telephone_number', value)}
                        />
                    </div>

                    <div className="space-y-3.5">
                        <p className="blanc-eyebrow">Authorized representative</p>
                        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                            <FloatingField label="Full name" value={form.authorized_representative} onChange={event => setField('authorized_representative', event.target.value)} />
                            <FloatingField label="Email" type="email" value={form.authorized_representative_email} onChange={event => setField('authorized_representative_email', event.target.value)} />
                        </div>
                    </div>

                    <div className="space-y-3.5">
                        <p className="blanc-eyebrow">Service address</p>
                        <FloatingField label="Street address" value={form.address_street} onChange={event => setField('address_street', event.target.value)} />
                        <FloatingField label="Apt, suite, or unit (optional)" value={form.address_street2} onChange={event => setField('address_street2', event.target.value)} />
                        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                            <FloatingField label="City" value={form.address_city} onChange={event => setField('address_city', event.target.value)} />
                            <FloatingField label="State" value={form.address_state} onChange={event => setField('address_state', event.target.value)} />
                        </div>
                        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                            <FloatingField label="ZIP code" value={form.address_zip} onChange={event => setField('address_zip', event.target.value)} />
                            <FloatingField label="Country" value={form.address_country} onChange={event => setField('address_country', event.target.value)} />
                        </div>
                    </div>

                    <div className="space-y-3.5">
                        <p className="blanc-eyebrow">Transfer details</p>
                        <div>
                            <FloatingField
                                label="Target transfer date (optional)"
                                type="date"
                                value={form.target_port_in_date}
                                onChange={event => setField('target_port_in_date', event.target.value)}
                            />
                            <p className="mt-1.5 text-xs text-[var(--blanc-ink-3)]">Choose a date at least 7 days from today.</p>
                            {targetDateError && <div className="mt-1.5"><InlineError text={targetDateError} /></div>}
                        </div>
                        <div className="space-y-2">
                            <p className="text-sm text-[var(--blanc-ink-2)]">
                                A recent bill from your current carrier — Twilio needs it to verify the account
                            </p>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                                className="hidden"
                                onChange={event => selectUtilityBill(event.target.files?.[0])}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                                <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                                    <FileText className="size-4" /> Choose utility bill
                                </Button>
                                {utilityBill && <span className="text-xs text-[var(--blanc-ink-2)]">{utilityBill.name}</span>}
                            </div>
                        </div>
                    </div>

                    {formError && <InlineError text={formError} />}

                    <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={submitTransfer} disabled={submitting}>
                            {submitting && <Loader2 className="size-4 animate-spin" />}
                            Start the transfer
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setStage('number')} disabled={submitting}>
                            Back
                        </Button>
                    </div>
                </div>
            )}

            {!statusOnly && (
                <div className="space-y-1.5 text-[13px] text-[var(--blanc-ink-2)]">
                    <p>Transfers usually take 2–4 weeks.</p>
                    <p>You'll need account details from your current carrier.</p>
                    <p>The authorized representative will receive an email to sign.</p>
                    <p>Your number keeps working with your current carrier until the transfer finishes.</p>
                </div>
            )}
        </div>
    );
}

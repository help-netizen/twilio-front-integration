import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsPageShell } from '../../components/settings/SettingsPageShell';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { PhoneInput, formatUSPhone, isValidUSPhone, toE164 } from '../../components/ui/PhoneInput';
import { telephonyApi, TelephonyBlacklistError } from '../../services/telephonyApi';
import type { BlacklistNumber } from '../../types/telephony';

const QUERY_KEY = ['telephony-blacklist'] as const;

export default function BlacklistPage() {
    const queryClient = useQueryClient();
    const [addOpen, setAddOpen] = useState(false);
    const [phoneNumber, setPhoneNumber] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [removeTarget, setRemoveTarget] = useState<BlacklistNumber | null>(null);

    const blacklistQuery = useQuery({
        queryKey: QUERY_KEY,
        queryFn: telephonyApi.listBlacklistNumbers,
    });
    const numbers = blacklistQuery.data || [];

    const addMutation = useMutation({
        mutationFn: telephonyApi.addBlacklistNumber,
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            setAddOpen(false);
            setPhoneNumber('');
            setFieldError(null);
            toast.success('Number added to blacklist');
        },
        onError: (error) => {
            if (error instanceof TelephonyBlacklistError &&
                ['PHONE_ALREADY_BLACKLISTED', 'INVALID_PHONE_NUMBER'].includes(error.code || '')) {
                setFieldError(error.message);
                return;
            }
            toast.error(error instanceof Error ? error.message : 'Failed to add the number');
        },
    });

    const removeMutation = useMutation({
        mutationFn: telephonyApi.removeBlacklistNumber,
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            setRemoveTarget(null);
            toast.success('Number removed from blacklist');
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : 'Failed to remove the number');
        },
    });

    const openAddPanel = () => {
        setPhoneNumber('');
        setFieldError(null);
        setAddOpen(true);
    };

    const submitNumber = () => {
        if (!isValidUSPhone(phoneNumber)) {
            setFieldError('Enter a complete 10-digit phone number.');
            return;
        }

        const normalized = toE164(phoneNumber);
        if (numbers.some(number => number.phone_e164 === normalized)) {
            setFieldError('This number is already on the blacklist.');
            return;
        }

        setFieldError(null);
        addMutation.mutate(normalized);
    };

    return (
        <>
            <SettingsPageShell
                eyebrow="Telephony"
                title="Blacklist"
                description="Decline inbound calls from specific phone numbers before routing."
                actions={<Button onClick={openAddPanel}><Plus /> Add number</Button>}
            >
                <SettingsSection
                    title="Blocked numbers"
                    description="Calls only. Text messages and contacts are not changed."
                    flat
                >
                    {blacklistQuery.isLoading && (
                        <div className="space-y-2" aria-label="Loading blocked numbers">
                            {[0, 1].map(index => (
                                <div
                                    key={index}
                                    className="h-[62px] animate-pulse rounded-2xl"
                                    style={{ background: 'var(--blanc-field)' }}
                                />
                            ))}
                        </div>
                    )}

                    {blacklistQuery.isError && (
                        <div className="py-7">
                            <p className="text-sm" style={{ color: 'var(--blanc-danger)' }}>Failed to load the blacklist.</p>
                            <Button className="mt-4" variant="outline" onClick={() => blacklistQuery.refetch()}>Try again</Button>
                        </div>
                    )}

                    {blacklistQuery.isSuccess && numbers.length === 0 && (
                        <div className="px-1 py-8 text-left">
                            <h3
                                className="text-[17px] font-semibold"
                                style={{ fontFamily: 'var(--blanc-font-heading, inherit)', color: 'var(--blanc-ink-1)' }}
                            >
                                No blocked numbers
                            </h3>
                            <p className="mt-1.5 max-w-md text-[13px] leading-5" style={{ color: 'var(--blanc-ink-2)' }}>
                                All inbound callers can reach your normal call routing.
                            </p>
                            <Button className="mt-5" onClick={openAddPanel}>Add a number</Button>
                        </div>
                    )}

                    {blacklistQuery.isSuccess && numbers.length > 0 && (
                        <div>
                            <div className="space-y-2.5">
                                {numbers.map(number => (
                                    <div
                                        key={number.id}
                                        className="flex min-h-[62px] items-center gap-3 rounded-2xl px-4 py-3"
                                        style={{
                                            border: '1px solid var(--blanc-line)',
                                            background: 'var(--blanc-panel-surface)',
                                        }}
                                    >
                                        <Phone className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                                        <span className="min-w-0 flex-1 text-sm font-semibold tabular-nums" style={{ color: 'var(--blanc-ink-1)' }}>
                                            {formatUSPhone(number.phone_e164)}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            style={{ color: 'var(--blanc-danger)' }}
                                            onClick={() => setRemoveTarget(number)}
                                        >
                                            Remove
                                        </Button>
                                    </div>
                                ))}
                            </div>
                            <p className="mt-2.5 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                {numbers.length} blocked {numbers.length === 1 ? 'number' : 'numbers'}
                            </p>
                        </div>
                    )}
                </SettingsSection>
            </SettingsPageShell>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent variant="panel" size="sm">
                    <DialogPanelHeader>
                        <DialogTitle className="text-2xl">Add to blacklist</DialogTitle>
                        <DialogDescription className="sr-only">Add a phone number to the inbound call blacklist.</DialogDescription>
                    </DialogPanelHeader>
                    <DialogBody>
                        <div className="space-y-6">
                            <div>
                                <PhoneInput
                                    id="blacklist-phone-number"
                                    label="Phone number"
                                    value={phoneNumber}
                                    onChange={(value) => {
                                        setPhoneNumber(value);
                                        setFieldError(null);
                                    }}
                                    disabled={addMutation.isPending}
                                    autoComplete="tel"
                                />
                                <p className="min-h-[18px] px-0.5 pt-1.5 text-xs" style={{ color: 'var(--blanc-danger)' }}>
                                    {fieldError || ''}
                                </p>
                            </div>
                            <p className="text-[13px] leading-5" style={{ color: 'var(--blanc-ink-2)' }}>
                                <strong style={{ color: 'var(--blanc-ink-1)' }}>
                                    Inbound calls from this number will be declined before routing.
                                </strong>{' '}
                                Text messages are unaffected, and no contact link is created.
                            </p>
                        </div>
                    </DialogBody>
                    <DialogPanelFooter>
                        <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={addMutation.isPending}>Cancel</Button>
                        <Button onClick={submitNumber} disabled={addMutation.isPending}>
                            {addMutation.isPending ? 'Adding…' : 'Add number'}
                        </Button>
                    </DialogPanelFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
                <DialogContent variant="dialog" size="sm">
                    <DialogHeader>
                        <DialogTitle>Remove from blacklist?</DialogTitle>
                        <DialogDescription>
                            Calls from <strong style={{ color: 'var(--blanc-ink-1)' }}>{removeTarget ? formatUSPhone(removeTarget.phone_e164) : ''}</strong>{' '}
                            will follow your normal routing again.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={removeMutation.isPending}>Cancel</Button>
                        <Button
                            variant="destructive"
                            onClick={() => { if (removeTarget) removeMutation.mutate(removeTarget.id); }}
                            disabled={removeMutation.isPending}
                        >
                            {removeMutation.isPending ? 'Removing…' : 'Remove number'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

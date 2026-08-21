import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsSection } from '../../components/settings/SettingsSection';
import { Button } from '../../components/ui/button';
import {
    Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader,
    DialogPanelFooter, DialogPanelHeader, DialogTitle,
} from '../../components/ui/dialog';
import { PhoneInput, formatUSPhone, isValidUSPhone, toE164 } from '../../components/ui/PhoneInput';
import { telephonyApi, TelephonyBlacklistError } from '../../services/telephonyApi';
import type { AgentExclusionNumber } from '../../types/telephony';

const QUERY_KEY = ['telephony-agent-exclusions'] as const;

/**
 * AGENT-EXCLUSION-001: callers the AI voice agent must not answer. Unlike the
 * blacklist (which declines the call entirely), an excluded caller still gets
 * through — they just skip the agent and follow the normal human/voicemail path.
 * Blacklisted numbers are shown here read-only (they are already fully blocked).
 */
export function AgentExclusionsSection() {
    const queryClient = useQueryClient();
    const [addOpen, setAddOpen] = useState(false);
    const [phoneNumber, setPhoneNumber] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [removeTarget, setRemoveTarget] = useState<AgentExclusionNumber | null>(null);

    const query = useQuery({ queryKey: QUERY_KEY, queryFn: telephonyApi.listAgentExclusions });
    const manual = query.data?.manual || [];
    const fromBlacklist = query.data?.from_blacklist || [];
    const total = manual.length + fromBlacklist.length;

    const addMutation = useMutation({
        mutationFn: telephonyApi.addAgentExclusion,
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            setAddOpen(false); setPhoneNumber(''); setFieldError(null);
            toast.success('Number added — the agent won’t answer it');
        },
        onError: (error) => {
            if (error instanceof TelephonyBlacklistError &&
                ['PHONE_ALREADY_EXCLUDED', 'INVALID_PHONE_NUMBER'].includes(error.code || '')) {
                setFieldError(error.message); return;
            }
            toast.error(error instanceof Error ? error.message : 'Failed to add the number');
        },
    });

    const removeMutation = useMutation({
        mutationFn: telephonyApi.removeAgentExclusion,
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
            setRemoveTarget(null);
            toast.success('Number removed — the agent can answer it again');
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to remove the number'),
    });

    const openAddPanel = () => { setPhoneNumber(''); setFieldError(null); setAddOpen(true); };

    const submitNumber = () => {
        if (!isValidUSPhone(phoneNumber)) { setFieldError('Enter a complete 10-digit phone number.'); return; }
        const normalized = toE164(phoneNumber);
        if (manual.some(n => n.phone_e164 === normalized) || fromBlacklist.some(n => n.phone_e164 === normalized)) {
            setFieldError('This number is already excluded from the agent.'); return;
        }
        setFieldError(null);
        addMutation.mutate(normalized);
    };

    const row = (number: AgentExclusionNumber, readOnly: boolean) => (
        <div
            key={`${readOnly ? 'bl' : 'ex'}-${number.id}`}
            className="flex min-h-[62px] items-center gap-3 rounded-2xl px-4 py-3"
            style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-panel-surface)' }}
        >
            <Phone className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
            <span className="min-w-0 flex-1 blanc-l2-heading tabular-nums" style={{ color: 'var(--blanc-ink-1)' }}>
                {formatUSPhone(number.phone_e164)}
            </span>
            {readOnly ? (
                <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
                    style={{ background: 'var(--blanc-field)', color: 'var(--blanc-ink-2)' }}
                    title="Already fully blocked by the blacklist"
                >
                    <ShieldOff className="size-3" /> Blocked entirely
                </span>
            ) : (
                <Button variant="ghost" size="sm" style={{ color: 'var(--blanc-danger)' }} onClick={() => setRemoveTarget(number)}>
                    Remove
                </Button>
            )}
        </div>
    );

    return (
        <>
            <SettingsSection
                title="Voice agent exclusions"
                description="The AI voice agent won’t answer these callers. The call still comes through and follows your normal routing — a teammate or voicemail."
                flat
            >
                {query.isLoading && (
                    <div className="space-y-2" aria-label="Loading agent exclusions">
                        {[0, 1].map(i => (
                            <div key={i} className="h-[62px] animate-pulse rounded-2xl" style={{ background: 'var(--blanc-field)' }} />
                        ))}
                    </div>
                )}

                {query.isError && (
                    <div className="py-7">
                        <p className="blanc-l2" style={{ color: 'var(--blanc-danger)' }}>Failed to load agent exclusions.</p>
                        <Button className="mt-4" variant="outline" onClick={() => query.refetch()}>Try again</Button>
                    </div>
                )}

                {query.isSuccess && total === 0 && (
                    <div className="px-1 py-8 text-left">
                        <h3 className="blanc-section-heading" style={{ color: 'var(--blanc-ink-1)' }}>No exclusions</h3>
                        <p className="mt-1.5 max-w-md blanc-l2" style={{ color: 'var(--blanc-ink-2)' }}>
                            The agent answers every eligible caller. Add a number to keep it from picking up for someone specific.
                        </p>
                        <Button className="mt-5" onClick={openAddPanel}>Add a number</Button>
                    </div>
                )}

                {query.isSuccess && total > 0 && (
                    <div className="space-y-2.5">
                        {fromBlacklist.map(n => row(n, true))}
                        {manual.map(n => row(n, false))}
                        <div className="flex items-center justify-between pt-1">
                            <p className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                                {total} excluded {total === 1 ? 'number' : 'numbers'}
                                {fromBlacklist.length > 0 ? ` · ${fromBlacklist.length} from the blacklist` : ''}
                            </p>
                            <Button variant="outline" size="sm" onClick={openAddPanel}>Add number</Button>
                        </div>
                    </div>
                )}
            </SettingsSection>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent variant="panel" size="sm">
                    <DialogPanelHeader>
                        <DialogTitle className="text-2xl">Exclude from the agent</DialogTitle>
                        <DialogDescription className="sr-only">Add a phone number the voice agent must not answer.</DialogDescription>
                    </DialogPanelHeader>
                    <DialogBody>
                        <div className="space-y-6">
                            <div>
                                <PhoneInput
                                    id="agent-exclusion-phone-number"
                                    label="Phone number"
                                    value={phoneNumber}
                                    onChange={(value) => { setPhoneNumber(value); setFieldError(null); }}
                                    disabled={addMutation.isPending}
                                    autoComplete="tel"
                                />
                                <p className="min-h-[18px] px-0.5 pt-1.5 text-xs" style={{ color: 'var(--blanc-danger)' }}>{fieldError || ''}</p>
                            </div>
                            <p className="blanc-l2" style={{ color: 'var(--blanc-ink-2)' }}>
                                <strong style={{ color: 'var(--blanc-ink-1)' }}>The AI agent won’t answer this caller.</strong>{' '}
                                The call is not dropped — it follows your normal routing to a teammate or voicemail.
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
                        <DialogTitle>Let the agent answer again?</DialogTitle>
                        <DialogDescription>
                            The agent will answer calls from{' '}
                            <strong style={{ color: 'var(--blanc-ink-1)' }}>{removeTarget ? formatUSPhone(removeTarget.phone_e164) : ''}</strong>{' '}
                            like any other caller.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={removeMutation.isPending}>Cancel</Button>
                        <Button variant="destructive" onClick={() => { if (removeTarget) removeMutation.mutate(removeTarget.id); }} disabled={removeMutation.isPending}>
                            {removeMutation.isPending ? 'Removing…' : 'Remove number'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

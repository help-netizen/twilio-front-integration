import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogPanelFooter,
    DialogPanelHeader,
    DialogTitle,
} from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { FloatingField } from '../components/ui/floating-field';
import { Skeleton } from '../components/ui/skeleton';
import {
    fetchRateMeSettings,
    removeRateMeDomain,
    saveRateMeSettings,
    setRateMeDomain,
    verifyRateMeDomain,
    type RateMeDomain,
} from '../services/marketplaceApi';

interface RateMeSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

function statusChipClass(status: RateMeDomain['status']) {
    const color = status === 'pending'
        ? 'text-[var(--blanc-warning)]'
        : status === 'failed'
            ? 'text-[var(--blanc-danger)]'
            : 'text-[var(--blanc-success)]';
    return `inline-flex w-fit rounded-full bg-[var(--blanc-surface-muted)] px-2.5 py-1 text-xs font-medium ${color}`;
}

function statusChipLabel(domain: RateMeDomain) {
    if (domain.status === 'pending') return 'Waiting for DNS';
    if (domain.status === 'verified') return 'Verified';
    if (domain.status === 'active') return `Live at https://${domain.domain}`;
    return 'DNS check failed';
}

export function RateMeSettingsDialog({ open, onOpenChange }: RateMeSettingsDialogProps) {
    const queryClient = useQueryClient();
    const [googleReviewUrl, setGoogleReviewUrl] = useState('');
    const [domainInput, setDomainInput] = useState('');
    const [customDraftOpen, setCustomDraftOpen] = useState(false);
    const [hasHydrated, setHasHydrated] = useState(false);

    const settingsQuery = useQuery({
        queryKey: ['rate-me-settings'],
        queryFn: fetchRateMeSettings,
        enabled: open,
        refetchOnMount: 'always',
    });

    useEffect(() => {
        if (!open) {
            setHasHydrated(false);
            setCustomDraftOpen(false);
            return;
        }
        if (hasHydrated || settingsQuery.isFetching || !settingsQuery.data) return;

        setGoogleReviewUrl(settingsQuery.data.settings.google_review_url || '');
        setDomainInput(settingsQuery.data.domain?.domain || '');
        setCustomDraftOpen(false);
        setHasHydrated(true);
    }, [hasHydrated, open, settingsQuery.data, settingsQuery.isFetching]);

    useEffect(() => {
        if (!open || !settingsQuery.error) return;
        toast.error(settingsQuery.error.message || 'Failed to load Rate Me settings');
    }, [open, settingsQuery.error]);

    const saveMutation = useMutation({
        mutationFn: saveRateMeSettings,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['rate-me-settings'] });
            toast.success('Settings saved');
            onOpenChange(false);
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to save Rate Me settings');
        },
    });

    const setDomainMutation = useMutation({
        mutationFn: setRateMeDomain,
        onSuccess: savedDomain => {
            setDomainInput(savedDomain.domain);
            queryClient.invalidateQueries({ queryKey: ['rate-me-settings'] });
            toast.success('Domain saved');
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to save domain');
        },
    });

    const verifyDomainMutation = useMutation({
        mutationFn: verifyRateMeDomain,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['rate-me-settings'] });
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to verify domain');
        },
    });

    const removeDomainMutation = useMutation({
        mutationFn: removeRateMeDomain,
        onSuccess: () => {
            setDomainInput('');
            setCustomDraftOpen(false);
            queryClient.invalidateQueries({ queryKey: ['rate-me-settings'] });
            toast.success('Custom domain removed');
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to remove domain');
        },
    });

    const handleSave = () => {
        saveMutation.mutate({ google_review_url: googleReviewUrl.trim() || null });
    };

    const handleSaveDomain = () => {
        const domain = domainInput.trim();
        if (domain) setDomainMutation.mutate(domain);
    };

    const domain = settingsQuery.data?.domain ?? null;
    const publicHost = settingsQuery.data?.public_host || '';
    const customHosting = domain !== null || customDraftOpen;
    const firstLabel = domainInput.trim().split('.')[0] || 'rate';
    const normalizedDomainInput = domainInput.trim().toLowerCase();
    const domainChanged = normalizedDomainInput !== (domain?.domain || '');
    const domainBusy = setDomainMutation.isPending
        || verifyDomainMutation.isPending
        || removeDomainMutation.isPending;
    const showLoading = settingsQuery.isFetching && !hasHydrated;
    const showLoadError = settingsQuery.isError && !hasHydrated;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle
                        className="text-[22px] font-semibold leading-tight"
                        style={{ fontFamily: 'var(--blanc-font-heading)', color: 'var(--blanc-ink-1)' }}
                    >
                        Rate Me settings
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Configure Google reviews and hosting for Rate Me.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {showLoading && (
                            <div className="space-y-3.5" aria-busy="true">
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-4 w-36" />
                                <Skeleton className="h-32 w-full" />
                            </div>
                        )}

                        {showLoadError && (
                            <div className="space-y-3.5">
                                <p className="text-sm text-[var(--blanc-ink-2)]">
                                    Settings could not be loaded. Try again to continue.
                                </p>
                                <Button type="button" variant="outline" size="sm" onClick={() => settingsQuery.refetch()}>
                                    Retry
                                </Button>
                            </div>
                        )}

                        {hasHydrated && (
                            <>
                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">GOOGLE REVIEWS</div>
                                    <FloatingField
                                        id="rate-me-google-review-url"
                                        type="url"
                                        label="Google review link"
                                        value={googleReviewUrl}
                                        onChange={event => setGoogleReviewUrl(event.target.value)}
                                    />
                                    <p className="text-xs text-[var(--blanc-ink-3)]">
                                        5-star customers are sent here to leave a public review.
                                    </p>
                                </section>

                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">RATING PAGE HOSTING</div>
                                    <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--blanc-ink-1)]">
                                        <input
                                            type="radio"
                                            name="rate-me-hosting-mode"
                                            value="albusto"
                                            checked={!customHosting}
                                            onChange={() => {
                                                if (!domain) setCustomDraftOpen(false);
                                            }}
                                            className="mt-0.5 h-4 w-4 accent-[var(--blanc-accent)]"
                                        />
                                        <span className="space-y-1">
                                            <span className="block font-medium">On albusto.com</span>
                                            <span className="block text-xs text-[var(--blanc-ink-3)]">https://{publicHost}</span>
                                            {domain && (
                                                <span className="block text-xs text-[var(--blanc-ink-3)]">
                                                    Remove your custom domain below to switch back.
                                                </span>
                                            )}
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--blanc-ink-1)]">
                                        <input
                                            type="radio"
                                            name="rate-me-hosting-mode"
                                            value="custom"
                                            checked={customHosting}
                                            onChange={() => setCustomDraftOpen(true)}
                                            className="mt-0.5 h-4 w-4 accent-[var(--blanc-accent)]"
                                        />
                                        <span className="font-medium">On your own domain</span>
                                    </label>

                                    {customHosting && (
                                        <div className="ml-7 space-y-3.5">
                                            <div className="space-y-2">
                                                <FloatingField
                                                    id="rate-me-custom-domain"
                                                    label="Your subdomain"
                                                    value={domainInput}
                                                    onChange={event => setDomainInput(event.target.value)}
                                                    disabled={domainBusy}
                                                />
                                                <p className="text-xs text-[var(--blanc-ink-3)]">
                                                    Example: rate.yourcompany.com
                                                </p>
                                            </div>

                                            <div className="space-y-2 rounded-xl bg-[var(--blanc-surface-muted)] p-4 font-mono text-xs text-[var(--blanc-ink-1)]">
                                                <div>Type: CNAME</div>
                                                <div>Host/Name: {firstLabel}</div>
                                                <div>Target: {publicHost}</div>
                                                <code className="block whitespace-pre-wrap text-[var(--blanc-ink-2)]">
                                                    {firstLabel}  IN CNAME  {publicHost}
                                                </code>
                                            </div>

                                            {(!domain || domainChanged) && (
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={handleSaveDomain}
                                                    disabled={!normalizedDomainInput || domainBusy}
                                                >
                                                    {setDomainMutation.isPending ? 'Saving…' : 'Save domain'}
                                                </Button>
                                            )}

                                            {domain && (
                                                <div className="space-y-3.5">
                                                    <div className="space-y-2">
                                                        <span className={statusChipClass(domain.status)}>
                                                            {statusChipLabel(domain)}
                                                        </span>
                                                        {domain.status === 'failed' && domain.last_error && (
                                                            <p className="text-sm text-[var(--blanc-danger)]">{domain.last_error}</p>
                                                        )}
                                                    </div>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() => verifyDomainMutation.mutate()}
                                                            disabled={domainBusy || domainChanged}
                                                        >
                                                            {verifyDomainMutation.isPending
                                                                ? 'Checking…'
                                                                : domain.status === 'failed' ? 'Retry' : 'Verify'}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-[var(--blanc-danger)] hover:text-[var(--blanc-danger)]"
                                                            onClick={() => removeDomainMutation.mutate()}
                                                            disabled={domainBusy}
                                                        >
                                                            {removeDomainMutation.isPending ? 'Removing…' : 'Remove'}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </section>
                            </>
                        )}
                    </div>
                </DialogBody>

                <DialogPanelFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button
                        type="button"
                        onClick={handleSave}
                        disabled={!hasHydrated || saveMutation.isPending}
                    >
                        {saveMutation.isPending ? 'Saving…' : 'Save'}
                    </Button>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}

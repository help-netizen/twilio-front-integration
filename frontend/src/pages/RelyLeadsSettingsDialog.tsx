import { useEffect, useMemo, useState } from 'react';
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
import { Checkbox } from '../components/ui/checkbox';
import { FloatingField } from '../components/ui/floating-field';
import { Skeleton } from '../components/ui/skeleton';
import {
    fetchRelyLeadsSettings,
    saveRelyLeadsSettings,
    type RelyLeadsSettings,
} from '../services/marketplaceApi';

interface RelyLeadsSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

function splitZipTokens(value: string) {
    return value.split(/[\s,;]+/).map(token => token.trim()).filter(Boolean);
}

function previewZip(token: string) {
    const digits = token.replace(/\D/g, '');
    if (!digits) return null;
    const normalized = digits.length >= 5 ? digits.slice(0, 5) : digits.padStart(5, '0');
    return /^\d{5}$/.test(normalized) ? normalized : null;
}

function updateSelection(current: string[], value: string, checked: boolean) {
    if (checked) return current.includes(value) ? current : [...current, value];
    return current.filter(item => item !== value);
}

export function RelyLeadsSettingsDialog({ open, onOpenChange }: RelyLeadsSettingsDialogProps) {
    const queryClient = useQueryClient();
    const [zoneMode, setZoneMode] = useState<RelyLeadsSettings['zone']['mode']>('company');
    const [customZipText, setCustomZipText] = useState('');
    const [unitTypes, setUnitTypes] = useState<string[]>([]);
    const [brands, setBrands] = useState<string[]>([]);
    const [hasHydrated, setHasHydrated] = useState(false);

    const settingsQuery = useQuery({
        queryKey: ['rely-leads-settings'],
        queryFn: fetchRelyLeadsSettings,
        enabled: open,
        refetchOnMount: 'always',
    });

    useEffect(() => {
        if (!open) {
            setHasHydrated(false);
            return;
        }
        if (hasHydrated || settingsQuery.isFetching || !settingsQuery.data) return;

        setZoneMode(settingsQuery.data.settings.zone.mode);
        setCustomZipText(settingsQuery.data.settings.zone.custom_zips.join('\n'));
        setUnitTypes(settingsQuery.data.settings.unit_types);
        setBrands(settingsQuery.data.settings.brands);
        setHasHydrated(true);
    }, [hasHydrated, open, settingsQuery.data, settingsQuery.isFetching]);

    useEffect(() => {
        if (!open || !settingsQuery.error) return;
        const message = settingsQuery.error instanceof Error
            ? settingsQuery.error.message
            : 'Failed to load Rely Leads settings';
        toast.error(message);
    }, [open, settingsQuery.error]);

    const zipPreview = useMemo(() => {
        const tokens = splitZipTokens(customZipText);
        const recognized = new Set<string>();
        const invalid: string[] = [];

        tokens.forEach(token => {
            const normalized = previewZip(token);
            if (normalized) recognized.add(normalized);
            else invalid.push(token);
        });

        return { tokens, recognizedCount: recognized.size, invalidCount: invalid.length };
    }, [customZipText]);

    const saveMutation = useMutation({
        mutationFn: saveRelyLeadsSettings,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['rely-leads-settings'] });
            toast.success('Settings saved');
            onOpenChange(false);
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to save Rely Leads settings');
        },
    });

    const handleSave = () => {
        saveMutation.mutate({
            zone: {
                mode: zoneMode,
                custom_zips: zipPreview.tokens,
            },
            unit_types: unitTypes,
            brands,
        });
    };

    const catalogs = settingsQuery.data?.catalogs;
    const territory = settingsQuery.data?.territory;
    const territoryHint = territory?.active_mode === 'radius'
        ? 'Currently: radius areas'
        : 'Currently: ZIP list';
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
                        Rely Leads settings
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        Choose which Rely leads your company accepts.
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="mx-auto w-full max-w-[740px] space-y-6">
                        {showLoading && (
                            <div className="space-y-3.5" aria-busy="true">
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-16 w-full" />
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

                        {hasHydrated && catalogs && territory && (
                            <>
                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">SERVICE AREA</div>
                                    <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--blanc-ink-1)]">
                                        <input
                                            type="radio"
                                            name="rely-zone-mode"
                                            value="company"
                                            checked={zoneMode === 'company'}
                                            onChange={() => setZoneMode('company')}
                                            className="mt-0.5 h-4 w-4 accent-[var(--blanc-accent)]"
                                        />
                                        <span className="space-y-1">
                                            <span className="block font-medium">Same as company settings</span>
                                            <span className="block text-xs text-[var(--blanc-ink-3)]">{territoryHint}</span>
                                            {territory.has_data === false && (
                                                <span className="block text-xs text-[var(--blanc-warning)]">
                                                    Your company has no service territory data yet — leads are accepted everywhere until you add some
                                                </span>
                                            )}
                                        </span>
                                    </label>

                                    <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--blanc-ink-1)]">
                                        <input
                                            type="radio"
                                            name="rely-zone-mode"
                                            value="custom"
                                            checked={zoneMode === 'custom'}
                                            onChange={() => setZoneMode('custom')}
                                            className="mt-0.5 h-4 w-4 accent-[var(--blanc-accent)]"
                                        />
                                        <span className="font-medium">Custom ZIP list</span>
                                    </label>

                                    {zoneMode === 'custom' && (
                                        <div className="ml-7 space-y-2">
                                            <FloatingField
                                                id="rely-custom-zips"
                                                textarea
                                                rows={4}
                                                label="ZIP codes"
                                                value={customZipText}
                                                onChange={event => setCustomZipText(event.target.value)}
                                            />
                                            <p className="text-xs text-[var(--blanc-ink-3)]">
                                                {zipPreview.recognizedCount} ZIP codes recognized
                                            </p>
                                            {zipPreview.invalidCount > 0 && (
                                                <p className="text-xs text-[var(--blanc-warning)]">
                                                    {zipPreview.invalidCount} entries don't look like ZIP codes
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </section>

                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">UNIT TYPES</div>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {catalogs.unit_types.map((unitType, index) => {
                                            const id = `rely-unit-type-${index}`;
                                            return (
                                                <label key={unitType} htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--blanc-ink-1)]">
                                                    <Checkbox
                                                        id={id}
                                                        checked={unitTypes.includes(unitType)}
                                                        onCheckedChange={checked => setUnitTypes(current => updateSelection(current, unitType, checked === true))}
                                                    />
                                                    {unitType}
                                                </label>
                                            );
                                        })}
                                    </div>
                                    {unitTypes.length === 0 && (
                                        <p className="text-xs text-[var(--blanc-ink-3)]">No filter — all leads accepted</p>
                                    )}
                                </section>

                                <section className="space-y-3.5">
                                    <div className="blanc-eyebrow">BRANDS</div>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {catalogs.brands.map((brand, index) => {
                                            const id = `rely-brand-${index}`;
                                            return (
                                                <label key={brand} htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--blanc-ink-1)]">
                                                    <Checkbox
                                                        id={id}
                                                        checked={brands.includes(brand)}
                                                        onCheckedChange={checked => setBrands(current => updateSelection(current, brand, checked === true))}
                                                    />
                                                    {brand}
                                                </label>
                                            );
                                        })}
                                    </div>
                                    {brands.length === 0 && (
                                        <p className="text-xs text-[var(--blanc-ink-3)]">No filter — all leads accepted</p>
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

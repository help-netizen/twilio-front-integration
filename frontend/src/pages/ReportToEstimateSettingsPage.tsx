import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import {
    fetchReportToEstimateSettings,
    saveReportToEstimateSettings,
    type ReportToEstimateSettingsPatch,
} from '../services/marketplaceApi';

const MAX_INSTRUCTION_CHARS = 16000;

/**
 * REPORT-POLISH-001 — Setup page for the Report → Estimate app. Two independent, per-company
 * editable instructions: "Report preparation" (report_instruction_text — how a provider's rough
 * note is turned into a full report) and "Estimate preparation" (instruction_text — how a report
 * becomes a Price Book draft). Each block saves on its own.
 */
export function ReportToEstimateSettingsPage() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const settingsQuery = useQuery({
        queryKey: ['report-to-estimate-settings'],
        queryFn: fetchReportToEstimateSettings,
        refetchOnMount: 'always',
    });

    const [reportText, setReportText] = useState('');
    const [estimateText, setEstimateText] = useState('');
    const [hasHydrated, setHasHydrated] = useState(false);

    useEffect(() => {
        if (hasHydrated || settingsQuery.isFetching || !settingsQuery.data) return;
        setReportText(settingsQuery.data.report_instruction_text || '');
        setEstimateText(settingsQuery.data.instruction_text || '');
        setHasHydrated(true);
    }, [hasHydrated, settingsQuery.data, settingsQuery.isFetching]);

    useEffect(() => {
        if (!settingsQuery.error) return;
        toast.error((settingsQuery.error as Error).message || 'Failed to load settings');
    }, [settingsQuery.error]);

    const saveMutation = useMutation({
        mutationFn: (patch: ReportToEstimateSettingsPatch) => saveReportToEstimateSettings(patch),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['report-to-estimate-settings'] });
            toast.success('Instruction saved');
        },
        onError: (error: Error) => toast.error(error.message || 'Failed to save'),
    });

    const enabled = settingsQuery.data?.enabled ?? true;
    const savedReport = (settingsQuery.data?.report_instruction_text || '').trim();
    const savedEstimate = (settingsQuery.data?.instruction_text || '').trim();
    const pendingKey = (saveMutation.variables && Object.keys(saveMutation.variables)[0]) || null;

    const block = (
        key: 'report_instruction_text' | 'instruction_text',
        title: string,
        description: string,
        value: string,
        setValue: (v: string) => void,
        saved: string,
    ) => {
        const trimmed = value.trim();
        const dirty = trimmed !== saved;
        const valid = trimmed.length > 0 && trimmed.length <= MAX_INSTRUCTION_CHARS;
        const saving = saveMutation.isPending && pendingKey === key;
        return (
            <section className="space-y-3">
                <div>
                    <h2 className="text-lg font-semibold" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>{title}</h2>
                    <p className="mt-1 text-sm" style={{ color: 'var(--blanc-ink-2)' }}>{description}</p>
                </div>
                {settingsQuery.isLoading ? (
                    <Skeleton className="h-64 w-full rounded-xl" />
                ) : (
                    <>
                        <textarea
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            rows={16}
                            maxLength={MAX_INSTRUCTION_CHARS}
                            spellCheck
                            className="w-full resize-y rounded-xl border-[1.5px] border-transparent px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-[var(--blanc-line-strong)]"
                            style={{ background: 'var(--blanc-field)', color: 'var(--blanc-ink-1)', minHeight: 280, fontFamily: 'var(--blanc-font-body, inherit)' }}
                        />
                        <div className="flex items-center justify-end gap-2">
                            <Button
                                type="button"
                                onClick={() => saveMutation.mutate({ [key]: trimmed } as ReportToEstimateSettingsPatch)}
                                disabled={!dirty || !valid || saveMutation.isPending}
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </Button>
                        </div>
                    </>
                )}
            </section>
        );
    };

    return (
        <div className="blanc-page-wrapper">
            <div className="mx-auto w-full max-w-[820px] px-4 py-6 md:px-6 md:py-8 space-y-8">
                <div className="space-y-3">
                    <button
                        type="button"
                        onClick={() => navigate('/settings/integrations?tab=marketplace')}
                        className="inline-flex items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
                        style={{ color: 'var(--blanc-ink-2)' }}
                    >
                        <ArrowLeft className="size-4" /> Integrations
                    </button>
                    <h1 className="text-2xl font-semibold" style={{ color: 'var(--blanc-ink-1)', fontFamily: 'var(--blanc-font-heading)' }}>Report → Estimate</h1>
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                        Two AI instructions your team can tailor. Both always follow a fixed safety rule —
                        they never obey commands hidden inside a note or report.
                    </p>
                    {!enabled && (
                        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--blanc-accent-soft)', color: 'var(--blanc-ink-1)' }}>
                            This app is currently turned off. You can still edit the instructions — they apply once it is enabled again.
                        </div>
                    )}
                </div>

                {block(
                    'report_instruction_text',
                    'Report preparation',
                    'How a technician’s rough note is turned into a full professional report (the provider’s "Polish report" button).',
                    reportText,
                    setReportText,
                    savedReport,
                )}

                {block(
                    'instruction_text',
                    'Estimate preparation',
                    'How a report is turned into an estimate draft built from your Price Book (Generate from a report).',
                    estimateText,
                    setEstimateText,
                    savedEstimate,
                )}
            </div>
        </div>
    );
}

export default ReportToEstimateSettingsPage;

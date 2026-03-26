import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { Tag, Calendar, FileText } from 'lucide-react';
import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import type { LocalJob } from '../../services/jobsApi';
import { formatSchedule } from './jobHelpers';

// ─── Component ───────────────────────────────────────────────────────────────

export function JobMetadataSection({ job }: { job: LocalJob }) {
    const { customFields } = useLeadFormSettings();

    const meta = job.metadata || {};
    const hasAny = job.job_source || job.created_at || customFields.some(f => meta[f.api_name]);

    if (!hasAny) return null;

    return (
        <>
            <Separator />
            <div>
                <h4 className="font-medium mb-3">Metadata</h4>
                <div className="space-y-3">
                    {/* Source */}
                    {job.job_source && (
                        <div className="flex items-start gap-3">
                            <Tag className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <Label className="text-xs text-muted-foreground">Source</Label>
                                <div className="text-sm font-medium mt-1">{job.job_source}</div>
                            </div>
                        </div>
                    )}

                    {/* Created */}
                    {job.created_at && (
                        <div className="flex items-start gap-3">
                            <Calendar className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <Label className="text-xs text-muted-foreground">Created Date</Label>
                                <div className="text-sm font-medium mt-1">{formatSchedule(job.created_at).date}</div>
                            </div>
                        </div>
                    )}

                    {/* Custom fields from settings */}
                    {customFields.map(field => (
                        <div key={field.id} className="flex items-start gap-3">
                            <FileText className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <Label className="text-xs text-muted-foreground">{field.display_name}</Label>
                                <div className="text-sm font-medium mt-1 whitespace-pre-wrap">
                                    {meta[field.api_name] || <span className="text-muted-foreground">N/A</span>}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

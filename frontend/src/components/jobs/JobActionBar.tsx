import { Button } from '../ui/button';
import { Play, CheckCircle2, Navigation, Ban } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobActionBarProps {
    job: LocalJob;
    onMarkEnroute: (id: number) => void;
    onMarkInProgress: (id: number) => void;
    onMarkComplete: (id: number) => void;
    onCancel: (id: number) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobActionBar({
    job, onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
}: JobActionBarProps) {
    if (job.zb_canceled) return null;

    return (
        <div className="flex items-center gap-2 px-4 py-3 border-b bg-background">
            {job.zb_status === 'en-route' && (
                <Button variant="outline" size="default" className="gap-2 opacity-50 cursor-default" disabled>
                    <Navigation className="size-4" />
                    <span className="hidden sm:inline">En-route</span>
                </Button>
            )}
            {job.zb_status === 'scheduled' && (
                <Button variant="outline" size="default" className="gap-2"
                    onClick={() => onMarkEnroute(job.id)}>
                    <Navigation className="size-4" />
                    <span className="hidden sm:inline">En-route</span>
                </Button>
            )}
            {(job.zb_status === 'scheduled' || job.zb_status === 'en-route') && (
                <Button size="default" className="gap-2 flex-1 bg-orange-500 hover:bg-orange-600 text-white"
                    onClick={() => onMarkInProgress(job.id)}>
                    <Play className="size-4" />
                    Start Job
                </Button>
            )}
            {job.zb_status === 'in-progress' && (
                <Button variant="outline" size="default" className="gap-2 opacity-50 cursor-default" disabled>
                    <Play className="size-4" />
                    <span className="hidden sm:inline">In Progress</span>
                </Button>
            )}
            {(job.zb_status === 'in-progress' || job.zb_status === 'en-route' || job.zb_status === 'scheduled') && (
                <Button variant="outline" size="default" className="gap-2"
                    onClick={() => onMarkComplete(job.id)}>
                    <CheckCircle2 className="size-4" />
                    <span className="hidden sm:inline">Complete</span>
                </Button>
            )}
            {job.zb_status !== 'complete' && (
                <Button variant="destructive" size="sm" className="gap-1 ml-auto"
                    onClick={() => onCancel(job.id)}>
                    <Ban className="size-3.5" />
                </Button>
            )}
        </div>
    );
}

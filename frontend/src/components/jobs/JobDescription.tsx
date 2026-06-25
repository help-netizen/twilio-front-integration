import type { LocalJob } from '../../services/jobsApi';

export function JobDescription({ job }: { job: LocalJob }) {
    return (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Description</h3>
            <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm whitespace-pre-wrap">{job.description || 'No description'}</p>
            </div>
        </div>
    );
}

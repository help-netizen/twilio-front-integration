import { Button } from '../ui/button';
import { X, FileText } from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobDetailHeaderProps {
    job: LocalJob;
    contactInfo: { id: number; name: string } | null;
    showMobileNotes: boolean;
    setShowMobileNotes: (v: boolean) => void;
    onClose: () => void;
    navigate: (path: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobDetailHeader({
    job, contactInfo, showMobileNotes, setShowMobileNotes,
    onClose, navigate,
}: JobDetailHeaderProps) {
    return (
        <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-5 text-white group/header">
            {/* First line: Service name + close/back */}
            <div className="flex items-center justify-between mb-2">
                <Button variant="ghost" size="sm" className="md:hidden text-white hover:bg-white/20" onClick={onClose}>
                    ← Back
                </Button>
                <h2 className="text-2xl font-bold hidden md:flex items-center gap-2">
                    {job.zenbooker_job_id ? (
                        <a
                            href={`https://zenbooker.com/app?view=jobs&view-job=${job.zenbooker_job_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-blue-100 hover:text-white hover:underline"
                            onClick={(e) => e.stopPropagation()}
                        >
                            #{job.job_number || job.id}
                        </a>
                    ) : (
                        <span className="font-mono text-blue-100">#{job.job_number || job.id}</span>
                    )}
                    {job.service_name || 'Job'}
                </h2>
                <div className="flex items-center gap-1 ml-auto">
                    <Button variant="ghost" size="sm"
                        className="md:hidden text-white hover:bg-white/20"
                        onClick={() => setShowMobileNotes(!showMobileNotes)}>
                        <FileText className="size-4 mr-1" /> Notes
                    </Button>
                    <Button variant="ghost" size="sm"
                        className="text-white hover:bg-white/20 opacity-0 group-hover/header:opacity-100 transition-opacity hidden md:inline-flex"
                        onClick={onClose}>
                        <X className="size-4" />
                    </Button>
                </div>
            </div>
            {/* Mobile title */}
            <h2 className="text-2xl font-bold mb-2 md:hidden">{job.service_name || 'Job'}</h2>

            <p className="text-blue-100 flex items-center gap-2">
                {contactInfo ? (
                    <span
                        className="hover:text-white hover:underline cursor-pointer transition-colors"
                        onClick={() => navigate(`/contacts/${contactInfo.id}`)}
                    >
                        {contactInfo.name}
                    </span>
                ) : (
                    job.customer_name || '—'
                )}
                {job.job_source && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white/20 text-white">
                        {job.job_source}
                    </span>
                )}
            </p>
        </div>
    );
}

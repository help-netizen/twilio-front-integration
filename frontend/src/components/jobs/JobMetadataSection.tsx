import { useLeadFormSettings } from '../../hooks/useLeadFormSettings';
import type { LocalJob } from '../../services/jobsApi';
import { formatSchedule } from './jobHelpers';

// ─── Styles ──────────────────────────────────────────────────────────────────

const KEY: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--blanc-ink-3)',
    minWidth: 80,
    paddingTop: 1,
    flexShrink: 0,
};

const VAL: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--blanc-ink-2)',
    flex: 1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function JobMetadataSection({ job }: { job: LocalJob }) {
    const { customFields } = useLeadFormSettings();

    const meta = job.metadata || {};
    const fields = customFields.filter(f => meta[f.api_name]);

    if (!job.created_at && fields.length === 0) return null;

    return (
        <div>
            <h4 className="blanc-eyebrow mb-2">Metadata</h4>
            <div>
                {job.created_at && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0' }}>
                        <span style={KEY}>Created</span>
                        <span style={VAL}>{formatSchedule(job.created_at).date}</span>
                    </div>
                )}
                {fields.map(field => (
                    <div key={field.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0' }}>
                        <span style={KEY}>{field.display_name}</span>
                        <span style={VAL}>{meta[field.api_name]}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

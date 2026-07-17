import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTemplates } from '../services/documentTemplatesApi';
import type { DocumentTemplate } from '../types/documentTemplates';

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
    estimate: 'Estimate',
    invoice: 'Invoice',
    work_order: 'Work Order',
};

export default function DocumentTemplatesPage() {
    const navigate = useNavigate();
    const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const items = await listTemplates();
                if (!cancelled) setTemplates(items);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="p-6 max-w-3xl">
            <h2 className="text-2xl font-heading mb-1">Document Templates</h2>
            <p className="blanc-eyebrow mb-6">Customize estimates, invoices, and work orders</p>

            {loading && <div className="text-sm text-[color:var(--blanc-ink-3)]">Loading…</div>}
            {error && <div className="text-sm text-[color:var(--blanc-danger,#be123c)]">{error}</div>}

            {!loading && !error && templates.length === 0 && (
                <div className="text-sm text-[color:var(--blanc-ink-3)]">No templates yet.</div>
            )}

            {!loading && !error && (
                <div className="flex flex-col gap-2">
                    {templates.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => navigate(`/settings/document-templates/${t.id}`)}
                            className="text-left rounded-xl border border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)] px-4 py-3 transition-colors bg-[color:var(--blanc-surface-strong,#fffdf9)]"
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{DOCUMENT_TYPE_LABELS[t.document_type] || t.document_type}</span>
                                    {t.is_default && (
                                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--blanc-ink-3)] border border-[color:var(--blanc-line)] rounded px-1.5 py-0.5">
                                            Default
                                        </span>
                                    )}
                                </div>
                                <span className="text-xs text-[color:var(--blanc-ink-3)]">
                                    Updated {new Date(t.updated_at).toLocaleDateString()}
                                </span>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

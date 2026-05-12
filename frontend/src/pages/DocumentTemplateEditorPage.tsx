import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    getTemplate,
    updateTemplate,
    resetTemplate,
} from '../services/documentTemplatesApi';
import { invalidateDocumentTemplateCache } from '../hooks/useDocumentTemplate';
import type {
    DocumentTemplate,
    LayoutPreset,
    TemplateDescriptorV1,
} from '../types/documentTemplates';
import { TemplateLivePreview } from '../components/documents/TemplateLivePreview';
import { TemplateStructure, ThemeSettings } from '../components/documents/TemplateStructure';

const HEX = /^#[0-9a-fA-F]{6}$/;

const DOCUMENT_TYPE_TITLES: Record<string, string> = {
    estimate: 'Estimate template',
    invoice: 'Invoice template',
    work_order: 'Work order template',
};

function isValid(d: TemplateDescriptorV1): boolean {
    if (!d.brand?.name) return false;
    if (d.theme.accent && !HEX.test(d.theme.accent)) return false;
    if (d.theme.ink && !HEX.test(d.theme.ink)) return false;
    if (!d.sections || d.sections.length === 0) return false;
    return true;
}

type Tab = 'structure' | 'preview';

export default function DocumentTemplateEditorPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [template, setTemplate] = useState<DocumentTemplate | null>(null);
    const [draft, setDraft] = useState<TemplateDescriptorV1 | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('structure');

    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        (async () => {
            try {
                const t = await getTemplate(Number(id));
                if (cancelled) return;
                setTemplate(t);
                setDraft(t.content);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [id]);

    const dirty = useMemo(() => {
        if (!template || !draft) return false;
        return JSON.stringify(draft) !== JSON.stringify(template.content);
    }, [draft, template]);

    const handleSave = async () => {
        if (!template || !draft) return;
        if (!isValid(draft)) {
            setError('Validation failed: brand name and valid hex theme colors are required.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const updated = await updateTemplate(template.id, { content: draft });
            setTemplate(updated);
            setDraft(updated.content);
            invalidateDocumentTemplateCache(updated.document_type);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    const handleReset = async () => {
        if (!template) return;
        if (!window.confirm('Reset this template to factory default? Current content will be discarded.')) return;
        setSaving(true);
        setError(null);
        try {
            const updated = await resetTemplate(template.id);
            setTemplate(updated);
            setDraft(updated.content);
            invalidateDocumentTemplateCache(updated.document_type);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    };

    if (!template || !draft) {
        return (
            <div className="p-6 max-w-3xl">
                {error ? (
                    <div className="text-sm text-[color:var(--blanc-danger,#be123c)]">{error}</div>
                ) : (
                    <div className="text-sm text-[color:var(--blanc-ink-3)]">Loading…</div>
                )}
            </div>
        );
    }

    return (
        <>
        <div className="p-6 pb-28 max-w-7xl">
            <button
                type="button"
                onClick={() => navigate('/settings/document-templates')}
                className="blanc-eyebrow mb-2 hover:underline"
            >
                ← Back
            </button>
            <h2 className="text-2xl font-heading mb-6">
                {DOCUMENT_TYPE_TITLES[template.document_type] ?? `${template.document_type} template`}
            </h2>

            {error && (
                <div className="text-sm text-[color:var(--blanc-danger,#be123c)] mb-4">{error}</div>
            )}

            <div className="mb-6 inline-flex rounded-xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] p-1">
                <TabButton active={tab === 'structure'} onClick={() => setTab('structure')}>Structure</TabButton>
                <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}>Preview</TabButton>
            </div>

            {tab === 'structure' && (
                <>
                    <TemplateStructure draft={draft} setDraft={setDraft} onError={setError} />
                    {template.document_type === 'invoice' && (
                        <InvoiceSettingsCard draft={draft} setDraft={setDraft} />
                    )}
                </>
            )}

            {tab === 'preview' && (
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-6 items-start">
                    <div>
                        <TemplateLivePreview descriptor={draft} />
                        <p className="text-[11px] text-[color:var(--blanc-ink-3)] mt-2">
                            Sample data shown for illustration. Real estimates use actual customer data.
                        </p>
                    </div>
                    <div className="lg:sticky lg:top-4 self-start flex flex-col gap-4">
                        <PresetSwitcher
                            value={draft.layout_preset ?? 'light'}
                            onChange={p => setDraft(prev => prev && { ...prev, layout_preset: p })}
                        />
                        <FontScaleControl
                            value={draft.font_scale ?? 1}
                            onChange={v => setDraft(prev => prev && { ...prev, font_scale: v })}
                        />
                        <ThemeSettings draft={draft} setDraft={setDraft} />
                    </div>
                </div>
            )}

        </div>
        <div className="fixed bottom-0 left-0 right-0 z-20 bg-[color:var(--blanc-surface-strong,#fffdf9)] border-t border-[color:var(--blanc-line)]">
            <div className="max-w-7xl px-6 py-3 flex items-center gap-3">
                <button
                    type="button"
                    disabled={saving}
                    onClick={handleReset}
                    className="px-4 py-2 rounded-xl border border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)]"
                >
                    Reset to default
                </button>
                {dirty && (
                    <span className="text-xs text-[color:var(--blanc-ink-3)]">Unsaved changes</span>
                )}
                <div className="flex-1" />
                <button
                    type="button"
                    disabled={!dirty || saving}
                    onClick={handleSave}
                    className="px-5 py-2 rounded-xl bg-[color:var(--blanc-ink-1)] text-white disabled:opacity-40 font-medium"
                >
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </div>
        </>
    );
}

const PRESET_DESCRIPTIONS: Record<LayoutPreset, { title: string; description: string }> = {
    light: {
        title: 'Light',
        description: 'Generous spacing, accent bars beside section labels, balanced typography.',
    },
    bold: {
        title: 'Bold',
        description: 'Thick borders, large headings, oversized totals — high-impact layout.',
    },
    minimal: {
        title: 'Minimal',
        description: 'Tight spacing, no accent bars, plain typography. Quiet and document-like.',
    },
};

function FontScaleControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const MIN = 0.7;
    const MAX = 1.6;
    const STEP = 0.1;
    const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v * 10) / 10));
    const dec = () => onChange(clamp(value - STEP));
    const inc = () => onChange(clamp(value + STEP));
    const pct = Math.round(value * 100);
    return (
        <aside className="rounded-2xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] shadow-sm p-5">
            <h3 className="text-sm font-semibold mb-1">Font size</h3>
            <p className="text-xs text-[color:var(--blanc-ink-3)] mb-4">
                Scale all text proportionally.
            </p>
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={dec}
                    disabled={value <= MIN + 0.001}
                    aria-label="Decrease font size"
                    className="size-8 rounded-full border border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)] flex items-center justify-center text-lg leading-none disabled:opacity-40"
                >
                    −
                </button>
                <input
                    type="range"
                    min={MIN}
                    max={MAX}
                    step={STEP}
                    value={value}
                    onChange={e => onChange(clamp(parseFloat(e.target.value)))}
                    className="flex-1 accent-[color:var(--blanc-ink-1)]"
                />
                <button
                    type="button"
                    onClick={inc}
                    disabled={value >= MAX - 0.001}
                    aria-label="Increase font size"
                    className="size-8 rounded-full border border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)] flex items-center justify-center text-lg leading-none disabled:opacity-40"
                >
                    +
                </button>
            </div>
            <div className="text-xs text-[color:var(--blanc-ink-3)] text-center mt-2">
                {pct}%
                {pct !== 100 && (
                    <button
                        type="button"
                        onClick={() => onChange(1)}
                        className="ml-2 underline hover:text-[color:var(--blanc-ink-2)]"
                    >
                        reset
                    </button>
                )}
            </div>
        </aside>
    );
}

function PresetSwitcher({ value, onChange }: { value: LayoutPreset; onChange: (p: LayoutPreset) => void }) {
    const presets: LayoutPreset[] = ['light', 'bold', 'minimal'];
    return (
        <aside className="rounded-2xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] shadow-sm p-5">
            <h3 className="text-sm font-semibold mb-1">Visual style</h3>
            <p className="text-xs text-[color:var(--blanc-ink-3)] mb-4">
                Switch the layout style of the document. Selected style is saved with the template.
            </p>
            <div className="flex flex-col gap-2">
                {presets.map(p => {
                    const active = value === p;
                    return (
                        <button
                            key={p}
                            type="button"
                            onClick={() => onChange(p)}
                            className={`text-left rounded-xl border px-4 py-3 transition-colors ${
                                active
                                    ? 'border-[color:var(--blanc-ink-1)] ring-2 ring-[color:var(--blanc-ink-1)]/15 bg-[color:var(--blanc-bg)]'
                                    : 'border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)]'
                            }`}
                        >
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">{PRESET_DESCRIPTIONS[p].title}</span>
                                {active && (
                                    <span className="text-[10px] uppercase tracking-wider text-[color:var(--blanc-ink-3)] border border-[color:var(--blanc-line)] rounded px-1.5 py-0.5">
                                        Selected
                                    </span>
                                )}
                            </div>
                            <p className="text-xs text-[color:var(--blanc-ink-3)] mt-1">{PRESET_DESCRIPTIONS[p].description}</p>
                        </button>
                    );
                })}
            </div>
        </aside>
    );
}

function InvoiceSettingsCard({
    draft,
    setDraft,
}: {
    draft: TemplateDescriptorV1;
    setDraft: React.Dispatch<React.SetStateAction<TemplateDescriptorV1 | null>>;
}) {
    const currentDays = draft.invoice_settings?.default_due_days;
    const initialDays = Number.isFinite(currentDays) ? Number(currentDays) : 14;
    const [days, setDays] = useState<string>(String(initialDays));

    const commit = (raw: string) => {
        const n = Math.max(0, Math.min(365, Math.floor(Number(raw) || 0)));
        setDays(String(n));
        setDraft(prev => prev && ({
            ...prev,
            invoice_settings: { ...(prev.invoice_settings || {}), default_due_days: n },
        }));
    };

    return (
        <div className="mt-6 rounded-2xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] p-5">
            <p className="text-sm font-semibold mb-1">Invoice settings</p>
            <p className="text-xs text-[color:var(--blanc-ink-3)] mb-4">
                Defaults applied to new invoices generated from this template.
            </p>
            <div className="flex flex-wrap items-center gap-3">
                <label className="text-sm text-[color:var(--blanc-ink-2)]">Due date period</label>
                <div className="inline-flex items-center gap-2">
                    <input
                        type="number"
                        min={0}
                        max={365}
                        value={days}
                        onChange={e => setDays(e.target.value)}
                        onBlur={e => commit(e.target.value)}
                        className="w-20 border border-[color:var(--blanc-line)] rounded-xl px-3 py-1.5 text-sm tabular-nums text-right"
                    />
                    <span className="text-sm text-[color:var(--blanc-ink-3)]">days</span>
                </div>
                <div className="flex flex-wrap gap-1 ml-2">
                    {[7, 14, 30, 60].map(preset => (
                        <button
                            key={preset}
                            type="button"
                            onClick={() => commit(String(preset))}
                            className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                                Number(days) === preset
                                    ? 'bg-[color:var(--blanc-ink-1)] text-white border-transparent'
                                    : 'border-[color:var(--blanc-line)] text-[color:var(--blanc-ink-2)] hover:border-[color:var(--blanc-ink-3)]'
                            }`}
                        >
                            Net {preset}
                        </button>
                    ))}
                </div>
            </div>
            <p className="mt-3 text-xs text-[color:var(--blanc-ink-3)]">
                New invoices created from this template will get a Due date {Number(days) || 0} day(s) after the issue date. You can still override per invoice.
            </p>
        </div>
    );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${
                active
                    ? 'bg-[color:var(--blanc-ink-1)] text-white'
                    : 'text-[color:var(--blanc-ink-2)] hover:text-[color:var(--blanc-ink-1)]'
            }`}
        >
            {children}
        </button>
    );
}

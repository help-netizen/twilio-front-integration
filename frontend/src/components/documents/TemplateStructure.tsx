import React, { useState } from 'react';
import { X, Plus, GripVertical, AlignLeft, AlignCenter, AlignRight, Lock, LockOpen } from 'lucide-react';
import {
    DndContext,
    PointerSensor,
    KeyboardSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    rectSortingStrategy,
    useSortable,
    sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
    SectionDescriptor,
    SectionKey,
    SectionWidth,
    TextAlign,
    TemplateDescriptorV1,
} from '../../types/documentTemplates';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

const WIDTH_SPAN: Record<SectionWidth, number> = { full: 6, two_thirds: 4, half: 3, third: 2 };
function widthOf(s: SectionDescriptor): SectionWidth { return s.width ?? 'full'; }

const ALL_KEYS: SectionKey[] = ['logo', 'header', 'document_meta', 'ach', 'client_addresses', 'summary', 'items', 'totals', 'terms'];

const SECTION_META: Record<SectionKey, { title: string; description: string }> = {
    logo: {
        title: 'Logo',
        description: 'Company logo image.',
    },
    header: {
        title: 'Header & Brand',
        description: 'Company name, address, and contact info.',
    },
    document_meta: {
        title: 'Estimate info',
        description: 'Estimate number, date, and status.',
    },
    ach: {
        title: 'ACH Payments',
        description: 'Bank, routing, and account number for client wire transfers.',
    },
    client_addresses: {
        title: 'Client & Addresses',
        description: 'Customer contact, billing address, and service address.',
    },
    summary: {
        title: 'Service Summary',
        description: 'Free-text summary of the issue, findings, and proposed work.',
    },
    items: {
        title: 'Items Table',
        description: 'Line items with quantity, rate, and amount.',
    },
    totals: {
        title: 'Totals',
        description: 'Subtotal, discount, tax, and total.',
    },
    terms: {
        title: 'Terms & Warranty',
        description: 'Legal text shown at the bottom of the document.',
    },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

interface Props {
    draft: TemplateDescriptorV1;
    setDraft: React.Dispatch<React.SetStateAction<TemplateDescriptorV1 | null>>;
    onError: (msg: string | null) => void;
}

export function TemplateStructure({ draft, setDraft, onError }: Props) {
    const [selected, setSelected] = useState<SectionKey>('header');
    /** Which tile's inline "+" menu is currently open (-1 = none, length = bottom Add button). */
    const [insertMenuOpenAt, setInsertMenuOpenAt] = useState<number | null>(null);

    const presentKeys = new Set<SectionKey>(draft.sections.map(s => s.key));

    // Pointer sensor with a small activation distance so a click on the drag handle
    // doesn't immediately trigger a drag; user must actually move the cursor a few px.
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        setDraft(prev => {
            if (!prev) return prev;
            const oldIndex = prev.sections.findIndex(s => s.key === active.id);
            const newIndex = prev.sections.findIndex(s => s.key === over.id);
            if (oldIndex < 0 || newIndex < 0) return prev;
            return { ...prev, sections: arrayMove(prev.sections, oldIndex, newIndex) };
        });
    };

    const removeSection = (key: SectionKey) => {
        setDraft(prev => prev && { ...prev, sections: prev.sections.filter(s => s.key !== key) });
        if (selected === key) {
            const remaining = draft.sections.filter(s => s.key !== key);
            if (remaining.length > 0) setSelected(remaining[0].key);
        }
    };

    /**
     * Place a section at `index` (0 = at start, length = at end).
     * - If `key` already exists in the array, MOVE it (preserving its descriptor).
     * - Otherwise, ADD a new default section.
     */
    const addSectionAt = (index: number, key: SectionKey) => {
        setDraft(prev => {
            if (!prev) return prev;
            const arr = [...prev.sections];
            const existingIdx = arr.findIndex(s => s.key === key);
            let descriptor: SectionDescriptor;
            let target = index;
            if (existingIdx >= 0) {
                descriptor = arr[existingIdx];
                arr.splice(existingIdx, 1);
                if (existingIdx < target) target -= 1;
            } else {
                descriptor = key === 'terms'
                    ? { key, visible: true, body_md: 'TERMS: ...', width: 'full' }
                    : { key, visible: true, width: 'full' };
            }
            arr.splice(target, 0, descriptor);
            return { ...prev, sections: arr };
        });
        setInsertMenuOpenAt(null);
        setSelected(key);
    };

    const setSectionWidth = (key: SectionKey, width: SectionWidth) => {
        setDraft(prev => prev && {
            ...prev,
            sections: prev.sections.map(s => s.key === key ? { ...s, width } : s),
        });
    };

    const setSectionAlign = (key: SectionKey, text_align: TextAlign) => {
        setDraft(prev => prev && {
            ...prev,
            sections: prev.sections.map(s => s.key === key ? { ...s, text_align } : s),
        });
    };

    const setSectionGlue = (key: SectionKey, glue: boolean) => {
        setDraft(prev => prev && {
            ...prev,
            sections: prev.sections.map(s => s.key === key ? { ...s, glue_with_next: glue } : s),
        });
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-6 items-start">
            {/* Structural tiles */}
            <div className="flex flex-col gap-3">

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={draft.sections.map(s => s.key)} strategy={rectSortingStrategy}>
                        <div className="grid grid-cols-6 gap-3">
                            {(() => {
                                // Build glue groups so that consecutive tiles where the previous has
                                // `glue_with_next: true` render inside a single grid cell side-by-side.
                                const groups: { items: { s: SectionDescriptor; idx: number }[]; span: number }[] = [];
                                draft.sections.forEach((s, idx) => {
                                    const last = groups[groups.length - 1];
                                    const prev = last && last.items[last.items.length - 1].s;
                                    const span = WIDTH_SPAN[widthOf(s)];
                                    if (prev && prev.glue_with_next) {
                                        last.items.push({ s, idx });
                                        last.span = Math.min(6, last.span + span);
                                    } else {
                                        groups.push({ items: [{ s, idx }], span });
                                    }
                                });
                                return groups.map((g, gIdx) => (
                                    <div
                                        key={`g:${gIdx}`}
                                        className={g.items.length > 1 ? 'flex items-stretch gap-1' : ''}
                                        style={{ gridColumn: `span ${g.span} / span ${g.span}` }}
                                    >
                                        {g.items.map(({ s, idx }) => (
                                            <SortableTile key={s.key} id={s.key} className={g.items.length > 1 ? 'flex-1 min-w-0' : ''}>
                                                {(dragHandleProps) => (
                                                    <>
                                                        <TileWithSettings
                                                            label={SECTION_META[s.key].title}
                                                            description={SECTION_META[s.key].description}
                                                            selected={selected === s.key}
                                                            onSelect={() => setSelected(s.key)}
                                                            onRemove={() => removeSection(s.key)}
                                                            dragHandleProps={dragHandleProps}
                                                        >
                                                            <SectionSkeleton sectionKey={s.key} draft={draft} />
                                                        </TileWithSettings>
                                                        <InsertHere
                                                            isOpen={insertMenuOpenAt === idx}
                                                            onToggle={() => setInsertMenuOpenAt(prev => prev === idx ? null : idx)}
                                                            onPick={(k) => addSectionAt(idx + 1, k)}
                                                            presentKeys={presentKeys}
                                                            hideOwnKey={s.key}
                                                        />
                                                        {idx < draft.sections.length - 1 && (
                                                            <GlueLock
                                                                glued={Boolean(s.glue_with_next)}
                                                                onToggle={() => setSectionGlue(s.key, !s.glue_with_next)}
                                                            />
                                                        )}
                                                    </>
                                                )}
                                            </SortableTile>
                                        ))}
                                    </div>
                                ));
                            })()}
                        </div>
                    </SortableContext>
                </DndContext>

                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setInsertMenuOpenAt(prev => prev === draft.sections.length ? null : draft.sections.length)}
                        className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)] py-3 text-sm text-[color:var(--blanc-ink-3)] transition-colors"
                    >
                        <Plus className="size-4" />
                        Add section
                    </button>
                    {insertMenuOpenAt === draft.sections.length && (
                        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] shadow-md overflow-hidden max-h-80 overflow-y-auto">
                            {ALL_KEYS.map(k => {
                                const isMove = presentKeys.has(k);
                                return (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => addSectionAt(draft.sections.length, k)}
                                        className="w-full text-left px-4 py-2 text-sm hover:bg-[color:var(--blanc-line)]/30"
                                    >
                                        <div className="font-medium flex items-center gap-2">
                                            {SECTION_META[k].title}
                                            {isMove && (
                                                <span className="text-[10px] uppercase tracking-wider text-[color:var(--blanc-ink-3)] border border-[color:var(--blanc-line)] rounded px-1.5 py-0.5">
                                                    Move here
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs text-[color:var(--blanc-ink-3)]">{SECTION_META[k].description}</div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Settings panel */}
            <aside className="lg:sticky lg:top-4 self-start">
                <SettingsPanel
                    selectedKey={selected}
                    draft={draft}
                    setDraft={setDraft}
                    onError={onError}
                    onSetWidth={setSectionWidth}
                    onSetAlign={setSectionAlign}
                />
            </aside>
        </div>
    );
}

/**
 * Glue indicator on the right edge of a tile, shown on hover (open lock) or
 * always visible if the tile is currently glued to the next one (closed lock).
 * Click toggles `glue_with_next` on this tile.
 */
function GlueLock({ glued, onToggle }: { glued: boolean; onToggle: () => void }) {
    const Icon = glued ? Lock : LockOpen;
    const label = glued ? 'Unglue from next block' : 'Glue to next block';
    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onToggle(); }}
                        aria-label={label}
                        className={`absolute -right-3 top-1/2 -translate-y-1/2 z-20 size-6 rounded-full border bg-[color:var(--blanc-surface-strong,#fffdf9)] flex items-center justify-center shadow-sm transition-opacity ${
                            glued
                                ? 'opacity-100 border-[color:var(--blanc-ink-1)] text-[color:var(--blanc-ink-1)]'
                                : 'opacity-0 group-hover/tile:opacity-100 hover:opacity-100 border-[color:var(--blanc-line)] text-[color:var(--blanc-ink-3)]'
                        }`}
                    >
                        <Icon className="size-3" />
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                    <p className="font-semibold mb-1">{label}</p>
                    <p>
                        {glued
                            ? 'These two blocks always sit on the same row — like the logo next to the company name. Click to break them apart so each one can use the full width again.'
                            : 'Lock this block to the one immediately after it so they always render side-by-side on the same row of the document. Useful for pairing things like the logo with the header.'}
                    </p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

/**
 * "+" indicator on the bottom-right corner of the parent tile.
 * Visible on hover (always available — even when all sections are placed).
 * Menu lists every section key. Picking a key:
 *   - MOVES it (if already placed elsewhere) to right after the parent tile
 *   - ADDS a fresh section (if not yet placed)
 */
function InsertHere({ isOpen, onToggle, onPick, presentKeys, hideOwnKey }: {
    isOpen: boolean;
    onToggle: () => void;
    onPick: (k: SectionKey) => void;
    presentKeys: Set<SectionKey>;
    hideOwnKey?: SectionKey;
}) {
    return (
        <>
            <TooltipProvider delayDuration={150}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={e => { e.stopPropagation(); onToggle(); }}
                            aria-label="Insert section after this one"
                            className={`absolute -bottom-2 -right-2 z-20 size-6 rounded-full border bg-[color:var(--blanc-ink-1)] text-white flex items-center justify-center shadow-sm transition-opacity ${
                                isOpen ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100 hover:opacity-100'
                            }`}
                        >
                            <Plus className="size-3.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                        Insert section after this one
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
            {isOpen && (
                <div
                    onClick={e => e.stopPropagation()}
                    className="absolute right-0 top-full mt-1 z-30 w-72 rounded-xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] shadow-md overflow-hidden max-h-80 overflow-y-auto"
                >
                    {ALL_KEYS.filter(k => k !== hideOwnKey).map(k => {
                        const isMove = presentKeys.has(k);
                        return (
                            <button
                                key={k}
                                type="button"
                                onClick={e => { e.stopPropagation(); onPick(k); }}
                                className="w-full text-left px-4 py-2 text-sm hover:bg-[color:var(--blanc-line)]/30 flex items-center gap-2"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="font-medium flex items-center gap-2">
                                        {SECTION_META[k].title}
                                        {isMove && (
                                            <span className="text-[10px] uppercase tracking-wider text-[color:var(--blanc-ink-3)] border border-[color:var(--blanc-line)] rounded px-1.5 py-0.5">
                                                Move here
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs text-[color:var(--blanc-ink-3)]">{SECTION_META[k].description}</div>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
}

interface DragHandleProps {
    setActivatorNodeRef: (node: HTMLElement | null) => void;
    attributes: React.HTMLAttributes<HTMLElement>;
    listeners: React.HTMLAttributes<HTMLElement> | undefined;
    isDragging: boolean;
}

/** Sortable wrapper around a single tile. Renders a grouping <div> that exposes
 *  drag-handle props via render-prop so the inner tile owns its own grip button. */
function SortableTile({ id, className, children }: {
    id: SectionKey;
    className?: string;
    children: (handle: DragHandleProps) => React.ReactNode;
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        setActivatorNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : undefined,
        zIndex: isDragging ? 10 : undefined,
    };

    return (
        <div ref={setNodeRef} style={style} className={`relative group/tile ${className ?? ''}`}>
            {children({ setActivatorNodeRef, attributes, listeners, isDragging })}
        </div>
    );
}

interface TileProps {
    label: string;
    description: string;
    selected: boolean;
    onSelect: () => void;
    onRemove?: () => void;
    fixed?: boolean;
    dragHandleProps?: DragHandleProps;
    children?: React.ReactNode;
}

function TileWithSettings({ label, description, selected, onSelect, onRemove, fixed, dragHandleProps, children }: TileProps) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
            className={`group relative cursor-pointer rounded-xl border bg-[color:var(--blanc-surface-strong,#fffdf9)] px-4 py-3 transition-all h-full ${
                selected
                    ? 'border-[color:var(--blanc-ink-1)] ring-2 ring-[color:var(--blanc-ink-1)]/15 shadow-sm'
                    : 'border-[color:var(--blanc-line)] hover:border-[color:var(--blanc-ink-3)]'
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-1 min-w-0">
                    {!fixed && dragHandleProps && (
                        <TooltipProvider delayDuration={150}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button
                                        ref={dragHandleProps.setActivatorNodeRef}
                                        type="button"
                                        {...dragHandleProps.attributes}
                                        {...(dragHandleProps.listeners ?? {})}
                                        onClick={e => e.stopPropagation()}
                                        className="-ml-1 mt-0.5 rounded p-0.5 cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-100 transition-opacity hover:bg-[color:var(--blanc-line)]/40 touch-none"
                                        aria-label="Drag to reorder"
                                    >
                                        <GripVertical className="size-3.5" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                    Drag to reorder
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}
                    <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{label}</div>
                        <div className="text-xs text-[color:var(--blanc-ink-3)] truncate">{description}</div>
                    </div>
                </div>
                {onRemove && (
                    <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onRemove(); }}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity rounded-md p-1 hover:bg-[color:var(--blanc-line)]/40 shrink-0"
                        aria-label="Remove section"
                        title="Remove section"
                    >
                        <X className="size-3.5" />
                    </button>
                )}
            </div>
            {children && <div className="mt-2">{children}</div>}
        </div>
    );
}

function SectionSkeleton({ sectionKey, draft }: { sectionKey: SectionKey; draft: TemplateDescriptorV1 }) {
    const muted = draft.theme.muted || '#5f7085';
    const faint = draft.theme.faint || '#eef3f8';
    if (sectionKey === 'logo') {
        return (
            <div className="flex items-center gap-2">
                {draft.brand.logo_url
                    ? <img src={draft.brand.logo_url} alt="" className="w-10 h-10 object-contain rounded" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    : <div className="w-10 h-10 rounded border border-dashed flex items-center justify-center text-[9px] uppercase tracking-wider" style={{ borderColor: muted, color: muted }}>Logo</div>}
            </div>
        );
    }
    if (sectionKey === 'header') {
        return (
            <div className="space-y-1">
                <div className="h-2 rounded w-2/5" style={{ background: faint }} />
                <div className="h-1.5 rounded w-3/5" style={{ background: faint, opacity: 0.7 }} />
                <div className="h-1.5 rounded w-1/2" style={{ background: faint, opacity: 0.6 }} />
            </div>
        );
    }
    if (sectionKey === 'document_meta') {
        return (
            <div className="space-y-1 text-right">
                <div className="ml-auto h-2 rounded w-1/3" style={{ background: faint }} />
                <div className="ml-auto h-1.5 rounded w-1/2" style={{ background: faint, opacity: 0.7 }} />
                <div className="ml-auto h-1.5 rounded w-1/4" style={{ background: faint, opacity: 0.6 }} />
            </div>
        );
    }
    if (sectionKey === 'ach') {
        return (
            <div className="grid grid-cols-3 gap-2 text-[10px]" style={{ color: muted }}>
                <div className="px-2 py-1 rounded" style={{ background: faint }}>BANK</div>
                <div className="px-2 py-1 rounded" style={{ background: faint }}>ROUTING</div>
                <div className="px-2 py-1 rounded" style={{ background: faint }}>ACCOUNT</div>
            </div>
        );
    }
    if (sectionKey === 'items') {
        return (
            <div className="space-y-1">
                <div className="grid grid-cols-[1fr_60px] gap-2"><div className="h-2 rounded" style={{ background: faint }} /><div className="h-2 rounded" style={{ background: faint }} /></div>
                <div className="grid grid-cols-[1fr_60px] gap-2"><div className="h-2 rounded w-3/4" style={{ background: faint, opacity: 0.7 }} /><div className="h-2 rounded" style={{ background: faint, opacity: 0.7 }} /></div>
            </div>
        );
    }
    if (sectionKey === 'totals') {
        return (
            <div className="flex justify-end">
                <div className="w-1/2 space-y-1">
                    <div className="flex justify-between"><div className="h-1.5 rounded w-12" style={{ background: faint }} /><div className="h-1.5 rounded w-10" style={{ background: faint }} /></div>
                    <div className="flex justify-between"><div className="h-1.5 rounded w-14" style={{ background: faint, opacity: 0.7 }} /><div className="h-1.5 rounded w-10" style={{ background: faint, opacity: 0.7 }} /></div>
                </div>
            </div>
        );
    }
    if (sectionKey === 'terms') {
        return (
            <div className="space-y-1">
                <div className="h-1.5 rounded w-full" style={{ background: faint, opacity: 0.7 }} />
                <div className="h-1.5 rounded w-11/12" style={{ background: faint, opacity: 0.6 }} />
                <div className="h-1.5 rounded w-3/4" style={{ background: faint, opacity: 0.5 }} />
            </div>
        );
    }
    if (sectionKey === 'client_addresses') {
        return (
            <div className="grid grid-cols-3 gap-2 text-[10px]" style={{ color: muted }}>
                <div><div className="h-1.5 rounded mb-1 w-2/3" style={{ background: faint }} /><div className="h-1.5 rounded w-full" style={{ background: faint, opacity: 0.7 }} /></div>
                <div><div className="h-1.5 rounded mb-1 w-2/3" style={{ background: faint }} /><div className="h-1.5 rounded w-full" style={{ background: faint, opacity: 0.7 }} /></div>
                <div><div className="h-1.5 rounded mb-1 w-2/3" style={{ background: faint }} /><div className="h-1.5 rounded w-full" style={{ background: faint, opacity: 0.7 }} /></div>
            </div>
        );
    }
    if (sectionKey === 'summary') {
        return (
            <div className="space-y-1">
                <div className="h-1.5 rounded w-full" style={{ background: faint, opacity: 0.7 }} />
                <div className="h-1.5 rounded w-4/5" style={{ background: faint, opacity: 0.6 }} />
            </div>
        );
    }
    return null;
}

interface SettingsProps {
    selectedKey: SectionKey;
    draft: TemplateDescriptorV1;
    setDraft: React.Dispatch<React.SetStateAction<TemplateDescriptorV1 | null>>;
    onError: (msg: string | null) => void;
    onSetWidth: (key: SectionKey, width: SectionWidth) => void;
    onSetAlign: (key: SectionKey, align: TextAlign) => void;
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="rounded-2xl border border-[color:var(--blanc-line)] bg-[color:var(--blanc-surface-strong,#fffdf9)] shadow-sm p-5">
            <div className="mb-4">
                <h3 className="text-sm font-semibold">{title}</h3>
                {description && <p className="text-xs text-[color:var(--blanc-ink-3)] mt-0.5">{description}</p>}
            </div>
            {children}
        </div>
    );
}

function WidthSelector({ value, onChange }: { value: SectionWidth; onChange: (w: SectionWidth) => void }) {
    const opts: Array<{ key: SectionWidth; label: string; fillUnits: number }> = [
        { key: 'full',       label: 'Full',  fillUnits: 6 },
        { key: 'two_thirds', label: '2/3',   fillUnits: 4 },
        { key: 'half',       label: '1/2',   fillUnits: 3 },
        { key: 'third',      label: '1/3',   fillUnits: 2 },
    ];
    return (
        <div className="mb-4">
            <div className="text-xs text-[color:var(--blanc-ink-3)] mb-1.5">Layout width</div>
            <div className="inline-flex rounded-xl border border-[color:var(--blanc-line)] p-1 bg-[color:var(--blanc-bg)]">
                {opts.map(o => {
                    const active = value === o.key;
                    return (
                        <button
                            key={o.key}
                            type="button"
                            onClick={() => onChange(o.key)}
                            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs transition-colors ${
                                active
                                    ? 'bg-[color:var(--blanc-ink-1)] text-white'
                                    : 'text-[color:var(--blanc-ink-2)] hover:bg-[color:var(--blanc-line)]/40'
                            }`}
                        >
                            <span
                                className="block h-3 rounded-sm"
                                style={{
                                    width: `${(o.fillUnits / 6) * 18}px`,
                                    background: active ? 'rgba(255,255,255,0.85)' : 'rgba(95,112,133,0.5)',
                                }}
                            />
                            {o.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function AlignmentSelector({ value, onChange }: { value: TextAlign; onChange: (a: TextAlign) => void }) {
    const opts: Array<{ key: TextAlign; Icon: typeof AlignLeft; label: string }> = [
        { key: 'left', Icon: AlignLeft, label: 'Left' },
        { key: 'center', Icon: AlignCenter, label: 'Center' },
        { key: 'right', Icon: AlignRight, label: 'Right' },
    ];
    return (
        <div className="mb-4">
            <div className="text-xs text-[color:var(--blanc-ink-3)] mb-1.5">Text alignment</div>
            <div className="inline-flex rounded-xl border border-[color:var(--blanc-line)] p-1 bg-[color:var(--blanc-bg)]">
                {opts.map(o => {
                    const active = value === o.key;
                    const Icon = o.Icon;
                    return (
                        <button
                            key={o.key}
                            type="button"
                            onClick={() => onChange(o.key)}
                            aria-label={o.label}
                            title={o.label}
                            className={`flex items-center justify-center w-9 h-7 rounded-lg transition-colors ${
                                active
                                    ? 'bg-[color:var(--blanc-ink-1)] text-white'
                                    : 'text-[color:var(--blanc-ink-2)] hover:bg-[color:var(--blanc-line)]/40'
                            }`}
                        >
                            <Icon className="size-4" />
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function SectionLayoutControls({ sectionKey, draft, onSetWidth, onSetAlign }: {
    sectionKey: SectionKey;
    draft: TemplateDescriptorV1;
    onSetWidth: (key: SectionKey, width: SectionWidth) => void;
    onSetAlign: (key: SectionKey, align: TextAlign) => void;
}) {
    const section = draft.sections.find(s => s.key === sectionKey);
    if (!section) return null;
    const defaultAlign: TextAlign = sectionKey === 'document_meta' ? 'right' : 'left';
    return (
        <>
            <WidthSelector value={section.width ?? 'full'} onChange={w => onSetWidth(sectionKey, w)} />
            <AlignmentSelector value={section.text_align ?? defaultAlign} onChange={a => onSetAlign(sectionKey, a)} />
        </>
    );
}

function SettingsPanel({ selectedKey, draft, setDraft, onError, onSetWidth, onSetAlign }: SettingsProps) {
    if (selectedKey === 'logo') return (
        <LogoSettings draft={draft} setDraft={setDraft} onError={onError}>
            <SectionLayoutControls sectionKey="logo" draft={draft} onSetWidth={onSetWidth} onSetAlign={onSetAlign} />
        </LogoSettings>
    );
    if (selectedKey === 'header') return (
        <BrandSettings draft={draft} setDraft={setDraft}>
            <SectionLayoutControls sectionKey="header" draft={draft} onSetWidth={onSetWidth} onSetAlign={onSetAlign} />
        </BrandSettings>
    );
    if (selectedKey === 'ach') return (
        <AchSettings draft={draft} setDraft={setDraft}>
            <SectionLayoutControls sectionKey="ach" draft={draft} onSetWidth={onSetWidth} onSetAlign={onSetAlign} />
        </AchSettings>
    );
    if (selectedKey === 'terms') return (
        <TermsSettings draft={draft} setDraft={setDraft}>
            <SectionLayoutControls sectionKey="terms" draft={draft} onSetWidth={onSetWidth} onSetAlign={onSetAlign} />
        </TermsSettings>
    );
    return (
        <Card
            title={SECTION_META[selectedKey].title}
            description={SECTION_META[selectedKey].description}
        >
            <SectionLayoutControls sectionKey={selectedKey} draft={draft} onSetWidth={onSetWidth} onSetAlign={onSetAlign} />
            <p className="text-sm text-[color:var(--blanc-ink-3)]">
                This section displays customer-specific data automatically. Click the ✕ on the tile to remove it.
            </p>
        </Card>
    );
}

const BRAND_LABELS: Record<string, string> = {
    name: 'Company name',
    address: 'Address',
    email: 'Email',
    phone: 'Phone',
};

function LogoControl({ draft, setDraft, onError }: { draft: TemplateDescriptorV1; setDraft: SettingsProps['setDraft']; onError: SettingsProps['onError'] }) {
    const setLogo = (v: string | null) => {
        setDraft(prev => prev && { ...prev, brand: { ...prev.brand, logo_url: v } });
    };
    return (
        <div className="flex items-center gap-3">
            <div className="w-20 h-20 rounded-xl border border-[color:var(--blanc-line)] flex items-center justify-center bg-white overflow-hidden shrink-0">
                {draft.brand.logo_url
                    ? <img src={draft.brand.logo_url} alt="logo" className="max-w-full max-h-full object-contain" />
                    : <span className="text-[10px] text-[color:var(--blanc-ink-3)] uppercase tracking-wider">No logo</span>}
            </div>
            <div className="flex-1 flex flex-col gap-2">
                <input
                    type="text"
                    placeholder="Paste image URL or upload a file"
                    className="border border-[color:var(--blanc-line)] rounded-xl px-3 py-2"
                    value={draft.brand.logo_url ?? ''}
                    onChange={e => setLogo(e.target.value || null)}
                />
                <div className="flex items-center gap-2 flex-wrap">
                    <label className="cursor-pointer rounded-xl border border-[color:var(--blanc-line)] px-3 py-1.5 text-xs hover:border-[color:var(--blanc-ink-3)]">
                        Upload file
                        <input
                            type="file"
                            accept="image/png,image/jpeg,image/svg+xml,image/webp"
                            className="hidden"
                            onChange={async e => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                if (f.size > 350 * 1024) {
                                    onError(`Image too large (${Math.round(f.size / 1024)}KB). Max 350KB.`);
                                    e.target.value = '';
                                    return;
                                }
                                const reader = new FileReader();
                                reader.onload = () => {
                                    setLogo(String(reader.result));
                                    onError(null);
                                };
                                reader.readAsDataURL(f);
                                e.target.value = '';
                            }}
                        />
                    </label>
                    {draft.brand.logo_url && (
                        <button
                            type="button"
                            onClick={() => setLogo(null)}
                            className="rounded-xl border border-[color:var(--blanc-line)] px-3 py-1.5 text-xs hover:border-[color:var(--blanc-ink-3)]"
                        >
                            Clear
                        </button>
                    )}
                    <span className="text-[10px] text-[color:var(--blanc-ink-3)]">PNG/JPG/SVG, up to 350KB</span>
                </div>
            </div>
        </div>
    );
}

function LogoSettings({ draft, setDraft, onError, children }: { draft: TemplateDescriptorV1; setDraft: SettingsProps['setDraft']; onError: SettingsProps['onError']; children?: React.ReactNode }) {
    return (
        <Card title="Logo" description="Image displayed at the top of the document.">
            {children}
            <LogoControl draft={draft} setDraft={setDraft} onError={onError} />
        </Card>
    );
}

function BrandSettings({ draft, setDraft, children }: { draft: TemplateDescriptorV1; setDraft: SettingsProps['setDraft']; children?: React.ReactNode }) {
    const setBrand = (k: keyof TemplateDescriptorV1['brand'], v: string | null) => {
        setDraft(prev => prev && { ...prev, brand: { ...prev.brand, [k]: v } });
    };
    return (
        <Card title="Header & Brand" description="Company name and contact info shown in the document header.">
            {children}
            <div className="grid grid-cols-2 gap-3">
                {(['name', 'address', 'email', 'phone'] as const).map(k => (
                    <label key={k} className="flex flex-col gap-1 text-sm">
                        <span className="text-[color:var(--blanc-ink-3)]">{BRAND_LABELS[k] ?? k}</span>
                        <input
                            type="text"
                            className="border border-[color:var(--blanc-line)] rounded-xl px-3 py-2"
                            value={draft.brand[k] ?? ''}
                            onChange={e => setBrand(k, e.target.value || null)}
                        />
                    </label>
                ))}
            </div>
        </Card>
    );
}

const ACH_LABELS: Record<string, string> = {
    bank: 'Bank',
    routing_number: 'Routing number',
    account_number: 'Account number',
};

function AchSettings({ draft, setDraft, children }: { draft: TemplateDescriptorV1; setDraft: SettingsProps['setDraft']; children?: React.ReactNode }) {
    const ach = draft.brand.ach ?? { bank: '', routing_number: '', account_number: '' };
    const achSection = draft.sections.find(s => s.key === 'ach');
    const inline = Boolean(achSection?.inline);
    const update = (k: keyof typeof ach, v: string) => {
        setDraft(prev => prev && {
            ...prev,
            brand: { ...prev.brand, ach: { ...(prev.brand.ach ?? {}), [k]: v } },
        });
    };
    const clearAch = () => {
        setDraft(prev => prev && { ...prev, brand: { ...prev.brand, ach: null } });
    };
    const toggleInline = () => {
        setDraft(prev => prev && {
            ...prev,
            sections: prev.sections.map(s => s.key === 'ach' ? { ...s, inline: !inline } : s),
        });
    };
    return (
        <Card title="ACH payment details" description="Banking info displayed for client wire transfers.">
            {children}
            <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
                <input
                    type="checkbox"
                    checked={inline}
                    onChange={toggleInline}
                    className="size-4 rounded border-[color:var(--blanc-line)] cursor-pointer"
                />
                <span>Display Bank / Routing / Account on a single line</span>
            </label>
            <div className="grid grid-cols-1 gap-3">
                {(['bank', 'routing_number', 'account_number'] as const).map(k => (
                    <label key={k} className="flex flex-col gap-1 text-sm">
                        <span className="text-[color:var(--blanc-ink-3)]">{ACH_LABELS[k] ?? k}</span>
                        <input
                            type="text"
                            className="border border-[color:var(--blanc-line)] rounded-xl px-3 py-2"
                            value={ach[k] ?? ''}
                            onChange={e => update(k, e.target.value)}
                        />
                    </label>
                ))}
            </div>
            {draft.brand.ach && (
                <button
                    type="button"
                    onClick={clearAch}
                    className="mt-3 text-xs text-[color:var(--blanc-ink-3)] hover:underline"
                >
                    Clear ACH details
                </button>
            )}
        </Card>
    );
}

function TermsSettings({ draft, setDraft, children }: { draft: TemplateDescriptorV1; setDraft: SettingsProps['setDraft']; children?: React.ReactNode }) {
    const terms = draft.sections.find(s => s.key === 'terms');
    const setBody = (v: string) => {
        setDraft(prev => prev && {
            ...prev,
            sections: prev.sections.map(s => s.key === 'terms' ? { ...s, body_md: v } : s),
        });
    };
    return (
        <Card title="Terms & warranty" description="Markdown (bold, lists, line breaks). Up to 8000 characters.">
            {children}
            <textarea
                className="w-full min-h-[280px] border border-[color:var(--blanc-line)] rounded-xl px-3 py-2 font-mono text-xs"
                value={terms?.body_md ?? ''}
                onChange={e => setBody(e.target.value)}
            />
            <div className="mt-2 text-[10px] text-[color:var(--blanc-ink-3)] text-right">
                {(terms?.body_md ?? '').length} / 8000
            </div>
        </Card>
    );
}

const THEME_LABELS: Record<string, string> = {
    ink: 'Body text',
    muted: 'Secondary text',
    faint: 'Section background',
    surface: 'Card background',
    border: 'Border',
    accent: 'Accent',
    danger: 'Discount / negative',
};

export function ThemeSettings({ draft, setDraft }: { draft: TemplateDescriptorV1; setDraft: React.Dispatch<React.SetStateAction<TemplateDescriptorV1 | null>> }) {
    const setColor = (k: keyof TemplateDescriptorV1['theme'], v: string) => {
        if (!HEX.test(v)) return;
        setDraft(prev => prev && { ...prev, theme: { ...prev.theme, [k]: v } });
    };
    return (
        <Card title="Theme" description="Brand colors applied across all sections.">
            <div className="grid grid-cols-2 gap-3">
                {(['ink', 'muted', 'faint', 'surface', 'border', 'accent', 'danger'] as const).map(k => (
                    <label key={k} className="flex items-center gap-3 text-sm">
                        <input
                            type="color"
                            className="w-10 h-10 rounded-lg border border-[color:var(--blanc-line)] cursor-pointer"
                            value={draft.theme[k] ?? '#000000'}
                            onChange={e => setColor(k, e.target.value)}
                        />
                        <span className="text-[color:var(--blanc-ink-3)]">{THEME_LABELS[k] ?? k}</span>
                    </label>
                ))}
            </div>
        </Card>
    );
}

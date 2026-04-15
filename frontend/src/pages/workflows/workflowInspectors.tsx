/**
 * Inspector sidebar panels for FSM Workflow Builder.
 *
 * FlowPropertiesPanel — shown when nothing selected (overview + SCXML preview)
 * StateInspector      — shown when a node is selected
 * TransitionInspector — shown when an edge is selected
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import type { Node, Edge } from '@xyflow/react';
import {
    Copy, Check, Trash2,
    // icon picker icons
    CheckCircle, XCircle, X, ArrowRight, ArrowLeft, ArrowUp, ArrowDown,
    Phone, PhoneOff, PhoneCall, PhoneMissed, PhoneIncoming, PhoneOutgoing,
    Mail, Send, Calendar, Clock, Clock1, Clock3, Clock9,
    User, Users, UserCheck, UserX, UserPlus,
    Briefcase, Wrench, Hammer,
    Flag, Tag, Star, Bookmark,
    RefreshCw, Repeat, RotateCw, RotateCcw,
    AlertTriangle, AlertCircle, Info, HelpCircle,
    Edit, Edit2, Edit3,
    Trash, FileText, Clipboard, ClipboardCheck,
    Plus, Minus, PlusCircle, MinusCircle,
    MessageSquare, MessageCircle,
    Bell, BellOff,
    Home, Building, Building2,
    MapPin, Navigation, Truck,
    DollarSign, CreditCard, Receipt,
    Settings, Sliders,
    Eye, EyeOff,
    Lock, Unlock, Key,
    Zap, Activity, TrendingUp, TrendingDown,
    ThumbsUp, ThumbsDown, Heart, Smile, Frown,
    Package, Box, Archive,
    Search, Filter, SortAsc,
    Link, ExternalLink,
    Upload, Download,
    Image, Camera,
    Headphones, Mic, MicOff,
    Share2, Forward,
    Ban, ShieldAlert, ShieldCheck,
} from 'lucide-react';
import type { WorkflowNodeData, WorkflowEdgeData } from './workflowScxmlCodec';
import { graphToScxml } from './workflowScxmlCodec';

// ─── Icon Picker ─────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
    'check': Check,
    'check-circle': CheckCircle,
    'x': X,
    'x-circle': XCircle,
    'arrow-right': ArrowRight,
    'arrow-left': ArrowLeft,
    'arrow-up': ArrowUp,
    'arrow-down': ArrowDown,
    'phone': Phone,
    'phone-off': PhoneOff,
    'phone-call': PhoneCall,
    'phone-missed': PhoneMissed,
    'phone-incoming': PhoneIncoming,
    'phone-outgoing': PhoneOutgoing,
    'mail': Mail,
    'send': Send,
    'calendar': Calendar,
    'clock': Clock,
    'clock-1': Clock1,
    'clock-3': Clock3,
    'clock-9': Clock9,
    'user': User,
    'users': Users,
    'user-check': UserCheck,
    'user-x': UserX,
    'user-plus': UserPlus,
    'briefcase': Briefcase,
    'wrench': Wrench,
    'tool': Wrench,
    'hammer': Hammer,
    'flag': Flag,
    'tag': Tag,
    'star': Star,
    'bookmark': Bookmark,
    'refresh-cw': RefreshCw,
    'repeat': Repeat,
    'rotate-cw': RotateCw,
    'rotate-ccw': RotateCcw,
    'alert-triangle': AlertTriangle,
    'alert-circle': AlertCircle,
    'info': Info,
    'help-circle': HelpCircle,
    'edit': Edit,
    'edit-2': Edit2,
    'edit-3': Edit3,
    'trash': Trash,
    'trash-2': Trash2,
    'file-text': FileText,
    'clipboard': Clipboard,
    'clipboard-check': ClipboardCheck,
    'plus': Plus,
    'minus': Minus,
    'plus-circle': PlusCircle,
    'minus-circle': MinusCircle,
    'message-square': MessageSquare,
    'message-circle': MessageCircle,
    'bell': Bell,
    'bell-off': BellOff,
    'home': Home,
    'building': Building,
    'building-2': Building2,
    'map-pin': MapPin,
    'navigation': Navigation,
    'truck': Truck,
    'dollar-sign': DollarSign,
    'credit-card': CreditCard,
    'receipt': Receipt,
    'settings': Settings,
    'sliders': Sliders,
    'eye': Eye,
    'eye-off': EyeOff,
    'lock': Lock,
    'unlock': Unlock,
    'key': Key,
    'zap': Zap,
    'activity': Activity,
    'trending-up': TrendingUp,
    'trending-down': TrendingDown,
    'thumbs-up': ThumbsUp,
    'thumbs-down': ThumbsDown,
    'heart': Heart,
    'smile': Smile,
    'frown': Frown,
    'package': Package,
    'box': Box,
    'archive': Archive,
    'search': Search,
    'filter': Filter,
    'sort-asc': SortAsc,
    'link': Link,
    'external-link': ExternalLink,
    'upload': Upload,
    'download': Download,
    'image': Image,
    'camera': Camera,
    'headphones': Headphones,
    'mic': Mic,
    'mic-off': MicOff,
    'share-2': Share2,
    'forward': Forward,
    'ban': Ban,
    'shield-alert': ShieldAlert,
    'shield-check': ShieldCheck,
};

const ICON_NAMES = Object.keys(ICON_MAP);

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        function handleClick(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    const filtered = useMemo(() => {
        const q = search.toLowerCase().trim();
        return q ? ICON_NAMES.filter(n => n.includes(q)) : ICON_NAMES;
    }, [search]);

    const CurrentIcon = value ? ICON_MAP[value] : null;

    return (
        <div ref={containerRef} style={{ position: 'relative' }}>
            {/* Trigger button */}
            <button
                type="button"
                onClick={() => { setOpen(o => !o); setSearch(''); }}
                style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--blanc-line)',
                    background: '#fff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13,
                    color: value ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-3)',
                }}
            >
                {CurrentIcon
                    ? <CurrentIcon size={16} color="var(--blanc-ink-2)" />
                    : <span style={{ width: 16, height: 16, display: 'inline-block' }} />
                }
                <span style={{ flex: 1 }}>{value || 'Выбрать иконку...'}</span>
                {value && (
                    <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); onChange(''); }}
                        style={{ color: 'var(--blanc-ink-3)', lineHeight: 1, padding: '0 2px' }}
                    >
                        ×
                    </span>
                )}
            </button>

            {/* Dropdown */}
            {open && (
                <div style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    right: 0,
                    zIndex: 1000,
                    background: '#fff',
                    border: '1px solid var(--blanc-line)',
                    borderRadius: 10,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                    overflow: 'hidden',
                }}>
                    {/* Search */}
                    <div style={{ padding: '8px 8px 6px' }}>
                        <input
                            autoFocus
                            type="text"
                            placeholder="Поиск..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            style={{
                                width: '100%',
                                fontSize: 12,
                                padding: '5px 8px',
                                borderRadius: 6,
                                border: '1px solid var(--blanc-line)',
                                outline: 'none',
                                background: 'rgba(117,106,89,0.04)',
                                boxSizing: 'border-box',
                            }}
                        />
                    </div>

                    {/* Grid */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(6, 1fr)',
                        gap: 2,
                        padding: '4px 6px 8px',
                        maxHeight: 240,
                        overflowY: 'auto',
                    }}>
                        {filtered.map(name => {
                            const Icon = ICON_MAP[name];
                            const selected = name === value;
                            return (
                                <button
                                    key={name}
                                    type="button"
                                    title={name}
                                    onClick={() => { onChange(name); setOpen(false); }}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '100%',
                                        aspectRatio: '1',
                                        borderRadius: 6,
                                        border: selected ? '1.5px solid #6366f1' : '1.5px solid transparent',
                                        background: selected ? 'rgba(99,102,241,0.08)' : 'transparent',
                                        cursor: 'pointer',
                                        padding: 4,
                                    }}
                                >
                                    <Icon size={16} color={selected ? '#6366f1' : 'var(--blanc-ink-2)'} />
                                </button>
                            );
                        })}
                        {filtered.length === 0 && (
                            <div style={{ gridColumn: '1/-1', textAlign: 'center', fontSize: 12, color: 'var(--blanc-ink-3)', padding: '12px 0' }}>
                                Ничего не найдено
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Flow Properties (nothing selected) ─────────────────────────────────────

interface FlowPropertiesProps {
    nodes: Node<WorkflowNodeData>[];
    edges: Edge[];
    initialStateId: string;
    machineTitle: string;
    machineKey: string;
    validationErrors?: string[];
    validationWarnings?: string[];
}

export function FlowPropertiesPanel({
    nodes,
    edges,
    initialStateId,
    machineTitle,
    machineKey,
    validationErrors,
    validationWarnings,
}: FlowPropertiesProps) {
    const [copied, setCopied] = useState(false);

    const scxml = useMemo(
        () => graphToScxml(nodes, edges, initialStateId, machineKey, machineTitle),
        [nodes, edges, initialStateId, machineKey, machineTitle],
    );

    const handleCopy = () => {
        navigator.clipboard.writeText(scxml);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Overview */}
            <div>
                <div className="blanc-eyebrow" style={{ marginBottom: 8 }}>
                    Flow Overview
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    <div style={{ color: 'var(--blanc-ink-2)' }}>
                        States: <strong style={{ color: 'var(--blanc-ink-1)' }}>{nodes.length}</strong>
                    </div>
                    <div style={{ color: 'var(--blanc-ink-2)' }}>
                        Transitions: <strong style={{ color: 'var(--blanc-ink-1)' }}>{edges.length}</strong>
                    </div>
                    <div style={{ color: 'var(--blanc-ink-2)' }}>
                        Initial: <strong style={{ color: 'var(--blanc-ink-1)' }}>{initialStateId || '—'}</strong>
                    </div>
                </div>
            </div>

            {/* Validation */}
            {(validationErrors?.length || validationWarnings?.length) ? (
                <div>
                    <div className="blanc-eyebrow" style={{ marginBottom: 8 }}>
                        Validation
                    </div>
                    {validationErrors?.map((e, i) => (
                        <div key={`err-${i}`} style={{ fontSize: 12, color: '#dc2626', marginBottom: 4 }}>
                            {e}
                        </div>
                    ))}
                    {validationWarnings?.map((w, i) => (
                        <div key={`warn-${i}`} style={{ fontSize: 12, color: '#d97706', marginBottom: 4 }}>
                            {w}
                        </div>
                    ))}
                </div>
            ) : null}

            {/* SCXML Preview */}
            <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div className="blanc-eyebrow">SCXML Output</div>
                    <button
                        onClick={handleCopy}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            color: 'var(--blanc-ink-3)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '2px 6px',
                            borderRadius: 4,
                        }}
                    >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
                <pre
                    style={{
                        fontSize: 10,
                        lineHeight: 1.5,
                        background: 'rgba(117,106,89,0.04)',
                        borderRadius: 8,
                        padding: 12,
                        overflow: 'auto',
                        maxHeight: 400,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontFamily: 'monospace',
                        color: 'var(--blanc-ink-2)',
                    }}
                >
                    {scxml}
                </pre>
            </div>
        </div>
    );
}

// ─── State Inspector ─────────────────────────────────────────────────────────

interface StateInspectorProps {
    node: Node<WorkflowNodeData>;
    edges: Edge[];
    nodes: Node<WorkflowNodeData>[];
    onUpdateNode: (id: string, data: Partial<WorkflowNodeData>) => void;
    onDeleteNode: (id: string) => void;
    onSetInitial: (id: string) => void;
}

export function StateInspector({
    node,
    edges,
    nodes: _nodes,
    onUpdateNode,
    onDeleteNode,
    onSetInitial,
}: StateInspectorProps) {
    const d = node.data;
    const outgoing = edges.filter((e) => e.source === node.id);
    const incoming = edges.filter((e) => e.target === node.id);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="blanc-eyebrow">State Inspector</div>

            {/* Status Name */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Status Name
                </label>
                <input
                    type="text"
                    value={d.label}
                    onChange={(e) => onUpdateNode(node.id, { label: e.target.value, statusName: e.target.value })}
                    style={{
                        width: '100%',
                        fontSize: 13,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--blanc-line)',
                        background: '#fff',
                        outline: 'none',
                    }}
                />
            </div>

            {/* State ID (read-only) */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    State ID
                </label>
                <div
                    style={{
                        fontSize: 12,
                        fontFamily: 'monospace',
                        padding: '6px 10px',
                        borderRadius: 8,
                        background: 'rgba(117,106,89,0.04)',
                        color: 'var(--blanc-ink-2)',
                    }}
                >
                    {d.stateId}
                </div>
            </div>

            {/* Is Initial */}
            {!d.isFinal && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                        type="checkbox"
                        checked={d.isInitial}
                        onChange={() => {
                            if (!d.isInitial) onSetInitial(node.id);
                        }}
                        disabled={d.isInitial}
                        style={{ accentColor: '#6366f1' }}
                    />
                    <span style={{ fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                        Initial State
                    </span>
                </div>
            )}

            {/* Connections summary */}
            <div style={{ fontSize: 12, color: 'var(--blanc-ink-3)' }}>
                {incoming.length} incoming, {outgoing.length} outgoing transitions
            </div>

            {/* Delete */}
            <button
                onClick={() => onDeleteNode(node.id)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: '#dc2626',
                    background: 'none',
                    border: '1px solid rgba(220,38,38,0.3)',
                    padding: '6px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    marginTop: 8,
                }}
            >
                <Trash2 size={14} />
                Delete State
            </button>
        </div>
    );
}

// ─── Transition Inspector ────────────────────────────────────────────────────

interface TransitionInspectorProps {
    edge: Edge;
    nodes: Node<WorkflowNodeData>[];
    onUpdateEdge: (id: string, data: Partial<WorkflowEdgeData>) => void;
    onDeleteEdge: (id: string) => void;
}

export function TransitionInspector({
    edge,
    nodes,
    onUpdateEdge,
    onDeleteEdge,
}: TransitionInspectorProps) {
    const ed = (edge.data || {}) as WorkflowEdgeData;
    const sourceNode = nodes.find((n) => n.id === edge.source);
    const targetNode = nodes.find((n) => n.id === edge.target);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="blanc-eyebrow">Transition Inspector</div>

            {/* Source → Target */}
            <div style={{ fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                <strong style={{ color: 'var(--blanc-ink-1)' }}>
                    {sourceNode?.data?.label || edge.source}
                </strong>
                {' → '}
                <strong style={{ color: 'var(--blanc-ink-1)' }}>
                    {targetNode?.data?.label || edge.target}
                </strong>
            </div>

            {/* Transition Name */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Transition Name
                </label>
                <input
                    type="text"
                    value={ed.label || ''}
                    onChange={(e) => onUpdateEdge(edge.id, { label: e.target.value })}
                    style={{
                        width: '100%',
                        fontSize: 13,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--blanc-line)',
                        background: '#fff',
                        outline: 'none',
                    }}
                />
            </div>

            {/* Transition ID (read-only) */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Transition ID
                </label>
                <div
                    style={{
                        fontSize: 12,
                        fontFamily: 'monospace',
                        padding: '6px 10px',
                        borderRadius: 8,
                        background: 'rgba(117,106,89,0.04)',
                        color: 'var(--blanc-ink-2)',
                    }}
                >
                    {ed.event || '—'}
                </div>
            </div>

            {/* Is Action */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                    type="checkbox"
                    checked={ed.isAction || false}
                    onChange={(e) => onUpdateEdge(edge.id, { isAction: e.target.checked })}
                    style={{ accentColor: '#6366f1' }}
                />
                <span style={{ fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                    Action Button
                </span>
            </div>

            {/* Icon */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Icon
                </label>
                <IconPicker
                    value={ed.icon || ''}
                    onChange={(v) => onUpdateEdge(edge.id, { icon: v })}
                />
            </div>

            {/* Order */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Order
                </label>
                <input
                    type="number"
                    value={ed.order ?? ''}
                    onChange={(e) =>
                        onUpdateEdge(edge.id, {
                            order: e.target.value === '' ? null : Number(e.target.value),
                        })
                    }
                    style={{
                        width: '100%',
                        fontSize: 13,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--blanc-line)',
                        background: '#fff',
                        outline: 'none',
                    }}
                />
            </div>

            {/* Confirm */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                    type="checkbox"
                    checked={ed.confirm || false}
                    onChange={(e) => onUpdateEdge(edge.id, { confirm: e.target.checked })}
                    style={{ accentColor: '#6366f1' }}
                />
                <span style={{ fontSize: 13, color: 'var(--blanc-ink-2)' }}>
                    Require Confirmation
                </span>
            </div>

            {/* Confirm Text (conditional) */}
            {ed.confirm && (
                <div>
                    <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                        Confirmation Text
                    </label>
                    <textarea
                        value={ed.confirmText || ''}
                        onChange={(e) => onUpdateEdge(edge.id, { confirmText: e.target.value })}
                        rows={2}
                        style={{
                            width: '100%',
                            fontSize: 13,
                            padding: '6px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--blanc-line)',
                            background: '#fff',
                            outline: 'none',
                            resize: 'vertical',
                        }}
                    />
                </div>
            )}

            {/* Roles */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Roles (comma-separated)
                </label>
                <input
                    type="text"
                    value={ed.roles || ''}
                    onChange={(e) => onUpdateEdge(edge.id, { roles: e.target.value })}
                    style={{
                        width: '100%',
                        fontSize: 13,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--blanc-line)',
                        background: '#fff',
                        outline: 'none',
                    }}
                />
            </div>

            {/* Hotkey */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Hotkey
                </label>
                <input
                    type="text"
                    value={ed.hotkey || ''}
                    onChange={(e) => onUpdateEdge(edge.id, { hotkey: e.target.value })}
                    placeholder="e.g. ctrl+d"
                    style={{
                        width: '100%',
                        fontSize: 13,
                        padding: '6px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--blanc-line)',
                        background: '#fff',
                        outline: 'none',
                    }}
                />
            </div>

            {/* Delete */}
            <button
                onClick={() => onDeleteEdge(edge.id)}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: '#dc2626',
                    background: 'none',
                    border: '1px solid rgba(220,38,38,0.3)',
                    padding: '6px 12px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    marginTop: 8,
                }}
            >
                <Trash2 size={14} />
                Delete Transition
            </button>
        </div>
    );
}

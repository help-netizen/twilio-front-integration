/**
 * Inspector sidebar panels for FSM Workflow Builder.
 *
 * FlowPropertiesPanel — shown when nothing selected (overview + SCXML preview)
 * StateInspector      — shown when a node is selected
 * TransitionInspector — shown when an edge is selected
 */

import { useState, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { Copy, Check, Trash2 } from 'lucide-react';
import type { WorkflowNodeData, WorkflowEdgeData } from './workflowScxmlCodec';
import { graphToScxml } from './workflowScxmlCodec';

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
    nodes,
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

            {/* Label */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Display Label
                </label>
                <input
                    type="text"
                    value={d.label}
                    onChange={(e) => onUpdateNode(node.id, { label: e.target.value })}
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

            {/* Status Name */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Status Name
                </label>
                <input
                    type="text"
                    value={d.statusName}
                    onChange={(e) => onUpdateNode(node.id, { statusName: e.target.value })}
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

            {/* Event */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Event Name
                </label>
                <input
                    type="text"
                    value={ed.event || ''}
                    onChange={(e) => onUpdateEdge(edge.id, { event: e.target.value })}
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

            {/* Label */}
            <div>
                <label style={{ fontSize: 11, color: 'var(--blanc-ink-3)', display: 'block', marginBottom: 4 }}>
                    Label
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
                <input
                    type="text"
                    value={ed.icon || ''}
                    onChange={(e) => onUpdateEdge(edge.id, { icon: e.target.value })}
                    placeholder="e.g. check, x-circle"
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

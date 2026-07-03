/**
 * Custom ReactFlow node & edge components for the FSM Workflow Builder.
 */

import { useState, memo } from 'react';
import { Handle, Position, getSmoothStepPath, BaseEdge, EdgeLabelRenderer, type NodeProps, type EdgeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';
import type { WorkflowNodeData } from './workflowScxmlCodec';

// ─── State Node ──────────────────────────────────────────────────────────────

export const WorkflowStateNode = memo(function WorkflowStateNode({
    data,
    selected,
}: NodeProps & { data: WorkflowNodeData }) {
    const borderColor = data.isInitial ? 'var(--blanc-accent)' : '#3b82f6';
    return (
        <div
            style={{
                minWidth: 200,
                padding: '10px 14px',
                borderRadius: 10,
                background: 'var(--blanc-panel-surface)',
                borderWidth: '2px 2px 2px 4px',
                borderStyle: 'solid',
                borderColor: `${selected ? 'var(--blanc-accent)' : 'var(--blanc-line)'} ${selected ? 'var(--blanc-accent)' : 'var(--blanc-line)'} ${selected ? 'var(--blanc-accent)' : 'var(--blanc-line)'} ${borderColor}`,
                boxShadow: selected
                    ? '0 0 0 3px color-mix(in srgb, var(--blanc-accent) 20%, transparent)'
                    : '0 1px 4px rgba(0,0,0,0.06)',
                cursor: 'grab',
                transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
        >
            <Handle
                type="target"
                position={Position.Top}
                style={{ background: borderColor, width: 8, height: 8 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--blanc-ink-1)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {data.label}
                    </div>
                    <div
                        style={{
                            fontSize: 10,
                            color: 'var(--blanc-ink-3)',
                            fontFamily: 'monospace',
                            marginTop: 2,
                        }}
                    >
                        {data.stateId}
                    </div>
                </div>
                {data.isInitial && (
                    <span
                        style={{
                            fontSize: 9,
                            fontWeight: 700,
                            color: '#059669',
                            background: '#ecfdf5',
                            padding: '1px 6px',
                            borderRadius: 4,
                            letterSpacing: '0.05em',
                            flexShrink: 0,
                        }}
                    >
                        START
                    </span>
                )}
            </div>
            <Handle
                type="source"
                position={Position.Bottom}
                style={{ background: borderColor, width: 8, height: 8 }}
            />
        </div>
    );
});

// ─── Final Node ──────────────────────────────────────────────────────────────

export const WorkflowFinalNode = memo(function WorkflowFinalNode({
    data,
    selected,
}: NodeProps & { data: WorkflowNodeData }) {
    return (
        <div
            style={{
                minWidth: 200,
                padding: '10px 14px',
                borderRadius: 10,
                background: 'var(--blanc-field)',
                borderWidth: '2px 2px 2px 4px',
                borderStyle: 'solid',
                borderColor: `${selected ? 'var(--blanc-accent)' : 'var(--blanc-line)'} ${selected ? 'var(--blanc-accent)' : 'var(--blanc-line)'} ${selected ? 'var(--blanc-accent)' : 'var(--blanc-line)'} var(--blanc-ink-3)`,
                boxShadow: selected
                    ? '0 0 0 3px color-mix(in srgb, var(--blanc-accent) 20%, transparent)'
                    : '0 1px 4px rgba(0,0,0,0.06)',
                cursor: 'grab',
                transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
        >
            <Handle
                type="target"
                position={Position.Top}
                style={{ background: 'var(--blanc-ink-3)', width: 8, height: 8 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--blanc-ink-2)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {data.label}
                    </div>
                    <div
                        style={{
                            fontSize: 10,
                            color: 'var(--blanc-ink-3)',
                            fontFamily: 'monospace',
                            marginTop: 2,
                        }}
                    >
                        {data.stateId}
                    </div>
                </div>
                <span
                    style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: 'var(--blanc-ink-2)',
                        background: 'rgba(25,25,25,0.06)',
                        padding: '1px 6px',
                        borderRadius: 4,
                        letterSpacing: '0.05em',
                        flexShrink: 0,
                    }}
                >
                    FINAL
                </span>
            </div>
        </div>
    );
});

// ─── Bipartite Source Node (left column) ─────────────────────────────────────

export const BipartiteSourceNode = memo(function BipartiteSourceNode({
    data,
    selected,
}: NodeProps & { data: WorkflowNodeData & { dimmed?: boolean; highlighted?: boolean; neutral?: boolean } }) {
    const highlighted = (data as any).highlighted;
    const dimmed = (data as any).dimmed;
    const neutral = (data as any).neutral;
    const accentColor = selected ? 'var(--blanc-accent)' : highlighted ? 'color-mix(in srgb, var(--blanc-accent) 60%, white)' : data.isInitial ? 'var(--blanc-accent)' : data.isFinal ? 'var(--blanc-ink-3)' : '#3b82f6';
    const borderCol = neutral ? 'transparent' : selected || highlighted ? accentColor : 'var(--blanc-line)';
    const leftBorder = neutral ? 'transparent' : accentColor;
    return (
        <div
            style={{
                width: 200,
                padding: '8px 12px',
                borderRadius: 8,
                background: neutral ? 'transparent' : data.isFinal ? 'var(--blanc-field)' : 'var(--blanc-panel-surface)',
                borderWidth: '1.5px 1.5px 1.5px 3px',
                borderStyle: 'solid',
                borderColor: `${borderCol} ${borderCol} ${borderCol} ${leftBorder}`,
                boxShadow: selected ? '0 0 0 3px color-mix(in srgb, var(--blanc-accent) 25%, transparent)' : highlighted ? '0 0 0 2px color-mix(in srgb, var(--blanc-accent) 12%, transparent)' : 'none',
                opacity: dimmed ? 0.15 : neutral ? 0.55 : 1,
                transition: 'box-shadow 0.15s, border-color 0.15s, opacity 0.15s',
                cursor: 'pointer',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: data.isFinal ? 'var(--blanc-ink-3)' : 'var(--blanc-ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {data.label}
                    </div>
                </div>
                {data.isInitial && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: '#059669', background: '#ecfdf5', padding: '0px 4px', borderRadius: 3, letterSpacing: '0.05em', flexShrink: 0 }}>START</span>
                )}
                {data.isFinal && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--blanc-ink-2)', background: 'rgba(25,25,25,0.06)', padding: '0px 4px', borderRadius: 3, letterSpacing: '0.05em', flexShrink: 0 }}>FINAL</span>
                )}
            </div>
            <Handle
                type="source"
                position={Position.Right}
                style={{ background: accentColor, width: 7, height: 7 }}
            />
        </div>
    );
});

// ─── Bipartite Target Node (right column) ────────────────────────────────────

export const BipartiteTargetNode = memo(function BipartiteTargetNode({
    data,
    selected,
}: NodeProps & { data: WorkflowNodeData & { dimmed?: boolean; highlighted?: boolean; neutral?: boolean } }) {
    const highlighted = (data as any).highlighted;
    const dimmed = (data as any).dimmed;
    const neutral = (data as any).neutral;
    const accentColor = selected ? 'var(--blanc-accent)' : highlighted ? 'color-mix(in srgb, var(--blanc-accent) 60%, white)' : data.isFinal ? 'var(--blanc-ink-3)' : '#3b82f6';
    const borderCol = neutral ? 'transparent' : selected || highlighted ? accentColor : 'var(--blanc-line)';
    const rightBorder = neutral ? 'transparent' : accentColor;
    return (
        <div
            style={{
                width: 200,
                padding: '8px 12px',
                borderRadius: 8,
                background: neutral ? 'transparent' : data.isFinal ? 'var(--blanc-field)' : 'var(--blanc-panel-surface)',
                borderWidth: '1.5px 3px 1.5px 1.5px',
                borderStyle: 'solid',
                borderColor: `${borderCol} ${rightBorder} ${borderCol} ${borderCol}`,
                boxShadow: selected ? '0 0 0 3px color-mix(in srgb, var(--blanc-accent) 25%, transparent)' : highlighted ? '0 0 0 2px color-mix(in srgb, var(--blanc-accent) 12%, transparent)' : 'none',
                opacity: dimmed ? 0.15 : neutral ? 0.55 : 1,
                transition: 'box-shadow 0.15s, border-color 0.15s, opacity 0.15s',
                cursor: 'pointer',
            }}
        >
            <Handle
                type="target"
                position={Position.Left}
                style={{ background: accentColor, width: 7, height: 7 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: data.isFinal ? 'var(--blanc-ink-3)' : 'var(--blanc-ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {data.label}
                    </div>
                </div>
                {data.isFinal && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--blanc-ink-2)', background: 'rgba(25,25,25,0.06)', padding: '0px 4px', borderRadius: 3, letterSpacing: '0.05em', flexShrink: 0 }}>FINAL</span>
                )}
            </div>
        </div>
    );
});

// ─── Bipartite Edge (label rendered in HTML overlay, always above SVG paths) ─

export function BipartiteEdge({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    label,
    labelStyle,
    data,
}: EdgeProps) {
    const [edgePath] = getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 8,
    });

    // Label placement: pinned right next to the node handle to avoid ambiguity.
    // Source focused → label near target handle (just left of it)
    // Target focused → label near source handle (just right of it)
    const nearSource = (data as any)?.labelNearSource;
    const lx = nearSource ? sourceX + 50 : targetX - 50;
    const ly = (nearSource ? sourceY : targetY) - 16;

    return (
        <>
            <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
            {label && (
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
                            pointerEvents: 'none',
                            fontSize: (labelStyle as any)?.fontSize || 10,
                            fontWeight: (labelStyle as any)?.fontWeight || 500,
                            color: (labelStyle as any)?.fill || 'var(--blanc-ink-2)',
                            background: 'rgba(255,255,255,0.95)',
                            padding: '1px 6px',
                            borderRadius: 3,
                            whiteSpace: 'nowrap',
                        }}
                        className="nodrag nopan"
                    >
                        {String(label)}
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    );
}

// ─── Insertable Edge (with + button on hover) ───────────────────────────────

/** Global callback for edge insertion — set by the builder page */
export let onEdgeInsertCallback: ((edgeId: string) => void) | null = null;
export function setOnEdgeInsert(cb: ((edgeId: string) => void) | null) {
    onEdgeInsertCallback = cb;
}

export function WorkflowInsertableEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    label,
    labelStyle,
}: EdgeProps) {
    const [hovered, setHovered] = useState(false);
    const [edgePath, labelX, labelY] = getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 8,
    });

    return (
        <>
            <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
            {label && (
                <text
                    x={labelX}
                    y={labelY - 10}
                    textAnchor="middle"
                    style={labelStyle as any}
                >
                    {String(label)}
                </text>
            )}
            {/* Wide invisible path for hover detection */}
            <path
                d={edgePath}
                fill="none"
                stroke="transparent"
                strokeWidth={24}
                style={{ pointerEvents: 'stroke' }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            />
            {hovered && (
                <foreignObject
                    x={labelX - 14}
                    y={labelY - 14}
                    width={28}
                    height={28}
                    style={{ overflow: 'visible', pointerEvents: 'none' }}
                >
                    <div style={{ pointerEvents: 'auto' }}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onEdgeInsertCallback?.(id);
                            }}
                            onMouseEnter={() => setHovered(true)}
                            style={{
                                width: 28,
                                height: 28,
                                borderRadius: '50%',
                                border: '2px solid var(--blanc-accent)',
                                background: 'var(--blanc-panel-surface)',
                                color: 'var(--blanc-accent)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 0,
                                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                                fontSize: 0,
                            }}
                        >
                            <Plus size={16} />
                        </button>
                    </div>
                </foreignObject>
            )}
        </>
    );
}

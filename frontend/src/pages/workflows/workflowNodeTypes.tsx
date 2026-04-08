/**
 * Custom ReactFlow node & edge components for the FSM Workflow Builder.
 */

import { useState, memo } from 'react';
import { Handle, Position, getSmoothStepPath, BaseEdge, type NodeProps, type EdgeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';
import type { WorkflowNodeData } from './workflowScxmlCodec';

// ─── State Node ──────────────────────────────────────────────────────────────

export const WorkflowStateNode = memo(function WorkflowStateNode({
    data,
    selected,
}: NodeProps & { data: WorkflowNodeData }) {
    const borderColor = data.isInitial ? '#6366f1' : '#3b82f6';
    return (
        <div
            style={{
                minWidth: 200,
                padding: '10px 14px',
                borderRadius: 10,
                background: '#fff',
                borderWidth: '2px 2px 2px 4px',
                borderStyle: 'solid',
                borderColor: `${selected ? '#6366f1' : 'rgba(117,106,89,0.18)'} ${selected ? '#6366f1' : 'rgba(117,106,89,0.18)'} ${selected ? '#6366f1' : 'rgba(117,106,89,0.18)'} ${borderColor}`,
                boxShadow: selected
                    ? '0 0 0 3px rgba(99,102,241,0.2)'
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
                            color: '#374151',
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
                            color: '#9ca3af',
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
                background: '#fafafa',
                borderWidth: '2px 2px 2px 4px',
                borderStyle: 'solid',
                borderColor: `${selected ? '#6366f1' : 'rgba(117,106,89,0.18)'} ${selected ? '#6366f1' : 'rgba(117,106,89,0.18)'} ${selected ? '#6366f1' : 'rgba(117,106,89,0.18)'} #9ca3af`,
                boxShadow: selected
                    ? '0 0 0 3px rgba(99,102,241,0.2)'
                    : '0 1px 4px rgba(0,0,0,0.06)',
                cursor: 'grab',
                transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
        >
            <Handle
                type="target"
                position={Position.Top}
                style={{ background: '#9ca3af', width: 8, height: 8 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: '#6b7280',
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
                            color: '#9ca3af',
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
                        color: '#6b7280',
                        background: '#f3f4f6',
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
                                border: '2px solid #6366f1',
                                background: '#fff',
                                color: '#6366f1',
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

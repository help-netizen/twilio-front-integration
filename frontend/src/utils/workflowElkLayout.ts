/**
 * Production-grade ELK Layered auto-layout for FSM workflow graphs.
 *
 * Implements the spec from docs/elk_layered_auto_layout_spec.md:
 * - Root/initial nodes → FIRST_SEPARATE layer
 * - Final nodes → LAST_SEPARATE layer
 * - Real measured node sizes (with fallback)
 * - Stable model ordering (by order, then id)
 * - Port support for multi-handle nodes
 * - ORTHOGONAL edge routing
 * - Separate connected components
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import { type Edge, type Node, Position, MarkerType } from '@xyflow/react';

// ─── Types ───────────────────────────────────────────────────────────────────

type WorkflowPortSide = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

type WorkflowPort = {
    id: string;
    side: WorkflowPortSide;
    index?: number;
};

type WorkflowNodeData = {
    isRoot?: boolean;
    isInitial?: boolean;
    isFinal?: boolean;
    order?: number;
    ports?: WorkflowPort[];
    [key: string]: unknown;
};

type WorkflowNode = Node<WorkflowNodeData>;
type WorkflowEdge = Edge;

// ─── Constants ───────────────────────────────────────────────────────────────

const elk = new ELK();

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 72;

const ELK_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.edgeRouting': 'ORTHOGONAL',

    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',

    'elk.spacing.nodeNode': '60',
    'elk.layered.spacing.nodeNodeBetweenLayers': '100',
    'elk.layered.spacing.edgeNodeBetweenLayers': '40',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '20',

    'elk.separateConnectedComponents': 'true',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNodeSize(node: WorkflowNode) {
    return {
        width: node.measured?.width ?? (node as any).width ?? DEFAULT_NODE_WIDTH,
        height: node.measured?.height ?? (node as any).height ?? DEFAULT_NODE_HEIGHT,
    };
}

function sortNodesForStableModelOrder(nodes: WorkflowNode[]) {
    return [...nodes].sort((a, b) => {
        const ao = typeof a.data?.order === 'number' ? a.data.order : Number.MAX_SAFE_INTEGER;
        const bo = typeof b.data?.order === 'number' ? b.data.order : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return String(a.id).localeCompare(String(b.id));
    });
}

function getPortRef(nodeId: string, handleId?: string | null) {
    if (!handleId) return nodeId;
    return `${nodeId}__${handleId}`;
}

function toElkNode(node: WorkflowNode) {
    const { width, height } = getNodeSize(node);
    const layoutOptions: Record<string, string> = {};

    // Root / initial nodes → top layer
    if (node.data?.isRoot || node.data?.isInitial) {
        layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST_SEPARATE';
    }

    // Final nodes → bottom layer
    if (node.data?.isFinal) {
        layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST_SEPARATE';
    }

    const elkNode: any = {
        id: node.id,
        width,
        height,
        layoutOptions,
    };

    // Multi-handle → ELK ports with fixed order
    if (node.data?.ports?.length) {
        elkNode.layoutOptions = {
            ...elkNode.layoutOptions,
            'elk.portConstraints': 'FIXED_ORDER',
        };

        elkNode.ports = node.data.ports.map((port, index) => ({
            id: getPortRef(node.id, port.id),
            width: 1,
            height: 1,
            layoutOptions: {
                'elk.port.side': port.side,
                'elk.port.index': String(port.index ?? index),
            },
        }));
    }

    return elkNode;
}

function toElkEdge(edge: WorkflowEdge) {
    return {
        id: edge.id,
        sources: [getPortRef(edge.source, edge.sourceHandle)],
        targets: [getPortRef(edge.target, edge.targetHandle)],
    };
}

// ─── Main layout function ────────────────────────────────────────────────────

export async function layoutWithElkLayered(
    nodes: WorkflowNode[],
    edges: WorkflowEdge[],
): Promise<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }> {
    if (nodes.length === 0) return { nodes, edges };

    const orderedNodes = sortNodesForStableModelOrder(nodes);

    const graph = {
        id: 'root',
        layoutOptions: ELK_OPTIONS,
        children: orderedNodes.map(toElkNode),
        edges: edges.map(toElkEdge),
    };

    const layouted = await elk.layout(graph);

    const nextNodes: WorkflowNode[] = orderedNodes.map((node) => {
        const laidOut = layouted.children?.find((n: any) => n.id === node.id);

        return {
            ...node,
            position: {
                x: laidOut?.x ?? node.position.x,
                y: laidOut?.y ?? node.position.y,
            },
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
        };
    });

    const nextEdges: WorkflowEdge[] = edges.map((edge) => ({
        ...edge,
        markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed },
    }));

    return {
        nodes: nextNodes,
        edges: nextEdges,
    };
}

// ─── Bipartite two-column layout ─────────────────────────────────────────────

const BIPARTITE_ROW_HEIGHT = 64;
const BIPARTITE_COLUMN_GAP = 480;
const _BIPARTITE_NODE_WIDTH = 200; // reserved for future bipartite layout

/**
 * Bipartite two-column layout for FSM transition visualization.
 * Left column = source states (FROM), right column = target states (TO).
 * Edges connect left→right showing available transitions.
 *
 * Each state is duplicated: {id}__src (left) and {id}__tgt (right).
 * Edges are remapped: {source}__src → {target}__tgt.
 */
export function layoutBipartite(
    nodes: WorkflowNode[],
    edges: WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
    if (nodes.length === 0) return { nodes: [], edges: [] };

    // Sort: initial first, then non-final alphabetically, final last
    const sorted = [...nodes].sort((a, b) => {
        if (a.data?.isInitial && !b.data?.isInitial) return -1;
        if (!a.data?.isInitial && b.data?.isInitial) return 1;
        if (a.data?.isFinal && !b.data?.isFinal) return 1;
        if (!a.data?.isFinal && b.data?.isFinal) return -1;
        return String(a.id).localeCompare(String(b.id));
    });

    // Build sets of connected source/target IDs for dimming
    const sourceIds = new Set(edges.map(e => e.source));
    const targetIds = new Set(edges.map(e => e.target));

    const bipartiteNodes: WorkflowNode[] = [];

    for (let i = 0; i < sorted.length; i++) {
        const node = sorted[i];
        const y = i * BIPARTITE_ROW_HEIGHT;
        const hasOutgoing = sourceIds.has(node.id);
        const hasIncoming = targetIds.has(node.id);

        // Left column node (source)
        bipartiteNodes.push({
            ...node,
            id: `${node.id}__src`,
            type: 'bipartiteSource',
            position: { x: 0, y },
            draggable: false,
            data: {
                ...node.data,
                originalId: node.id,
                bipartiteRole: 'source',
                dimmed: !hasOutgoing,
            } as any,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
        } as any);

        // Right column node (target)
        bipartiteNodes.push({
            ...node,
            id: `${node.id}__tgt`,
            type: 'bipartiteTarget',
            position: { x: BIPARTITE_COLUMN_GAP, y },
            draggable: false,
            data: {
                ...node.data,
                originalId: node.id,
                bipartiteRole: 'target',
                dimmed: !hasIncoming,
            } as any,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
        } as any);
    }

    // Remap edges: source__src → target__tgt
    // Labels hidden by default — only shown when a node is focused
    const bipartiteEdges: WorkflowEdge[] = edges.map(edge => ({
        ...edge,
        id: `${edge.id}__bip`,
        source: `${edge.source}__src`,
        target: `${edge.target}__tgt`,
        type: 'bipartiteEdge',
        label: '',
        sourceHandle: null,
        targetHandle: null,
        markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed },
        data: {
            ...(edge.data || {}),
            originalEdgeId: edge.id,
            originalSource: edge.source,
            originalTarget: edge.target,
        },
    } as any));

    return { nodes: bipartiteNodes, edges: bipartiteEdges };
}

// ─── Backward-compatible alias ───────────────────────────────────────────────

export const layoutWorkflowGraph = layoutWithElkLayered;

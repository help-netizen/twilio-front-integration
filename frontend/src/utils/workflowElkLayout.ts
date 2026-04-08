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

// ─── Backward-compatible alias ───────────────────────────────────────────────

export const layoutWorkflowGraph = layoutWithElkLayered;

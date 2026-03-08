import ELK from "elkjs/lib/elk.bundled.js";
import { Edge, Node, Position, MarkerType } from "@xyflow/react";

export type WorkflowPortSide = "NORTH" | "SOUTH" | "EAST" | "WEST";

export type WorkflowPort = {
  id: string;
  side: WorkflowPortSide;
  index?: number;
};

export type WorkflowNodeData = {
  isRoot?: boolean;
  isFinal?: boolean;
  order?: number;
  ports?: WorkflowPort[];
};

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export type ElkLayeredLayoutOptions = {
  fitSpacing?: {
    nodeNode?: number;
    nodeNodeBetweenLayers?: number;
    edgeNodeBetweenLayers?: number;
  };
  considerModelOrder?: "NONE" | "NODES_AND_EDGES" | "PREFER_EDGES" | "PREFER_NODES";
  edgeRouting?: "ORTHOGONAL" | "POLYLINE" | "SPLINES";
  separateConnectedComponents?: boolean;
  favorStraightEdges?: boolean;
  edgeStraightening?: "NONE" | "IMPROVE_STRAIGHTNESS";
};

const elk = new ELK();

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 72;

function getNodeSize(node: WorkflowNode) {
  return {
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
  };
}

function sortNodesForStableModelOrder(nodes: WorkflowNode[]) {
  return [...nodes].sort((a, b) => {
    const ao = typeof a.data?.order === "number" ? a.data.order : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.data?.order === "number" ? b.data.order : Number.MAX_SAFE_INTEGER;

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

  if (node.data?.isRoot) {
    layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST_SEPARATE";
  }

  if (node.data?.isFinal) {
    layoutOptions["elk.layered.layering.layerConstraint"] = "LAST_SEPARATE";
  }

  const elkNode: any = {
    id: node.id,
    width,
    height,
    layoutOptions,
  };

  if (node.data?.ports?.length) {
    elkNode.layoutOptions = {
      ...elkNode.layoutOptions,
      "elk.portConstraints": "FIXED_ORDER",
    };

    elkNode.ports = node.data.ports.map((port, index) => ({
      id: getPortRef(node.id, port.id),
      width: 1,
      height: 1,
      layoutOptions: {
        "elk.port.side": port.side,
        "elk.port.index": String(port.index ?? index),
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

function getBaseOptions(options?: ElkLayeredLayoutOptions): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.edgeRouting": options?.edgeRouting ?? "ORTHOGONAL",

    "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.edgeStraightening": options?.edgeStraightening ?? "IMPROVE_STRAIGHTNESS",
    "elk.layered.nodePlacement.favorStraightEdges": String(options?.favorStraightEdges ?? true),
    "elk.layered.considerModelOrder.strategy": options?.considerModelOrder ?? "PREFER_NODES",

    "elk.spacing.nodeNode": String(options?.fitSpacing?.nodeNode ?? 48),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(options?.fitSpacing?.nodeNodeBetweenLayers ?? 120),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(options?.fitSpacing?.edgeNodeBetweenLayers ?? 32),

    "elk.separateConnectedComponents": String(options?.separateConnectedComponents ?? true),
  };
}

export async function layoutWithElkLayered(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options?: ElkLayeredLayoutOptions,
) {
  const orderedNodes = sortNodesForStableModelOrder(nodes);

  const graph = {
    id: "root",
    layoutOptions: getBaseOptions(options),
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
    type: edge.type ?? "smoothstep",
    markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed },
  }));

  return {
    nodes: nextNodes,
    edges: nextEdges,
  };
}

/**
 * Example usage:
 *
 * const { nodes: layoutedNodes, edges: layoutedEdges } = await layoutWithElkLayered(nodes, edges);
 * setNodes(layoutedNodes);
 * setEdges(layoutedEdges);
 * fitView({ padding: 0.2 });
 *
 * Node.data contract:
 * {
 *   isRoot?: boolean;
 *   isFinal?: boolean;
 *   order?: number;
 *   ports?: [{ id: "out-1", side: "SOUTH", index: 0 }]
 * }
 */

import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

/**
 * Manual positions for skeleton v2 visible nodes.
 *
 * Layout:  Hours Check (center, top)
 *          ├─ Business Hours edge → Current Group (left) → VM BH (left)
 *          └─ After Hours edge → VM AH (right)
 *
 * Start + hidden finals are not rendered, so no positions for them.
 */
const SKELETON_POSITIONS: Record<string, { x: number; y: number }> = {
    'sk-hours-check': { x: 275, y: 0 },
    // Left branch (Business Hours)
    'sk-current-group': { x: 0, y: 160 },
    'sk-vm-business-hours': { x: 0, y: 310 },
    // Right branch (After Hours)
    'sk-vm-after-hours': { x: 550, y: 160 },
};

export async function layoutWithElkLayered(
    nodes: { id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; data?: { kind?: string; config?: Record<string, unknown> } }[],
    edges: { id: string; source: string; target: string }[],
) {
    // If all visible nodes are skeleton nodes, use manual positions (fast path)
    const allSkeleton = nodes.every(n => SKELETON_POSITIONS[n.id]);
    if (allSkeleton) {
        return {
            nodes: nodes.map(n => ({
                ...n,
                position: SKELETON_POSITIONS[n.id] || n.position,
            })),
            edges,
        };
    }

    // Mixed graph: use ELK for layout but override skeleton positions
    const graph = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'DOWN',
            'elk.spacing.nodeNode': '200',
            'elk.layered.spacing.nodeNodeBetweenLayers': '80',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
            'elk.separateConnectedComponents': 'false',
        },
        children: nodes.map(n => ({
            id: n.id,
            width: n.measured?.width || 200,
            height: n.measured?.height || 60,
        })),
        edges: edges.map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };

    const laid = await elk.layout(graph);

    return {
        nodes: nodes.map(n => {
            if (SKELETON_POSITIONS[n.id]) {
                return { ...n, position: SKELETON_POSITIONS[n.id] };
            }
            const elkNode = laid.children?.find(c => c.id === n.id);
            return { ...n, position: { x: elkNode?.x ?? n.position.x, y: elkNode?.y ?? n.position.y } };
        }),
        edges,
    };
}

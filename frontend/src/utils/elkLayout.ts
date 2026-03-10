import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

const NODE_W = 200;
const NODE_H = 60;
const V_GAP = 80;   // vertical gap between nodes in a branch
const H_GAP = 350;  // horizontal gap between branch columns

/**
 * Manual positions for skeleton v2 visible nodes.
 *
 * Layout:  Hours Check (center, top)
 *          ├─ Business Hours → Current Group → VM BH (left column)
 *          └─ After Hours → VM AH (right column)
 *
 * Both Voicemail nodes sit at the same Y level.
 */
const SKELETON_POSITIONS: Record<string, { x: number; y: number }> = {
    'sk-hours-check': { x: 275, y: 0 },
    // Left branch (Business Hours)
    'sk-current-group': { x: 0, y: 160 },
    'sk-vm-business-hours': { x: 0, y: 310 },
    // Right branch (After Hours) — VM at same Y as BH VM
    'sk-vm-after-hours': { x: 550, y: 310 },
};

/** Skeleton node IDs that anchor the branches */
const BH_TERMINAL = 'sk-vm-business-hours';
const AH_TERMINAL = 'sk-vm-after-hours';
const HOURS_CHECK = 'sk-hours-check';

/**
 * Build adjacency list (source→targets) from edges.
 */
function buildAdj(edges: { source: string; target: string }[]): Map<string, string[]> {
    const adj = new Map<string, string[]>();
    for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        adj.get(e.source)!.push(e.target);
    }
    return adj;
}

/**
 * Walk a branch chain: given a starting node, follow the single outgoing edge
 * until we hit a known terminal or a node with no outgoing edges.
 * Returns the ordered list of node IDs in the chain (including start and end).
 */
function walkChain(startId: string, terminalId: string, adj: Map<string, string[]>, nodeSet: Set<string>): string[] {
    const chain: string[] = [startId];
    let current = startId;
    const visited = new Set<string>();
    visited.add(current);
    while (current !== terminalId) {
        const targets = (adj.get(current) || []).filter(t => nodeSet.has(t) && !visited.has(t));
        if (targets.length === 0) break;
        // Prefer the path toward the terminal
        const next = targets.find(t => t === terminalId) || targets[0];
        chain.push(next);
        visited.add(next);
        current = next;
    }
    return chain;
}

export async function layoutWithElkLayered(
    nodes: { id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; data?: any }[],
    edges: { id: string; source: string; target: string }[],
) {
    // Fast path: pure skeleton (no user-added nodes)
    const allSkeleton = nodes.every(n => SKELETON_POSITIONS[n.id]);
    if (allSkeleton) {
        return {
            nodes: nodes.map(n => ({ ...n, position: SKELETON_POSITIONS[n.id] || n.position })),
            edges,
        };
    }

    // ── Branch-aware layout for mixed graphs ────────────────────────────────
    const nodeSet = new Set(nodes.map(n => n.id));
    const adj = buildAdj(edges);

    // Discover BH and AH chains by walking from Hours Check's targets
    // Each target leads to one of the two terminals
    const hcTargets = (adj.get(HOURS_CHECK) || []).filter(t => nodeSet.has(t));

    /**  Check if nodeA can reach nodeB via adjacency */
    function canReach(from: string, to: string): boolean {
        const visited = new Set<string>();
        const queue = [from];
        while (queue.length > 0) {
            const cur = queue.shift()!;
            if (cur === to) return true;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const next of (adj.get(cur) || [])) {
                if (nodeSet.has(next) && !visited.has(next)) queue.push(next);
            }
        }
        return false;
    }

    // Classify Hours Check targets into BH/AH branches by reachability
    let bhStart: string | null = null;
    let ahStart: string | null = null;
    for (const t of hcTargets) {
        if (!bhStart && canReach(t, BH_TERMINAL)) bhStart = t;
        else if (!ahStart && canReach(t, AH_TERMINAL)) ahStart = t;
    }

    const bhChain = bhStart && nodeSet.has(BH_TERMINAL)
        ? walkChain(bhStart, BH_TERMINAL, adj, nodeSet)
        : [];
    const ahChain = ahStart && nodeSet.has(AH_TERMINAL)
        ? walkChain(ahStart, AH_TERMINAL, adj, nodeSet)
        : [];


    // Compute positions
    const positions = new Map<string, { x: number; y: number }>();

    // BH branch: left column, vertically stacked
    const bhX = 0;
    const branchTopY = 160; // first row under Hours Check
    for (let i = 0; i < bhChain.length; i++) {
        positions.set(bhChain[i], { x: bhX, y: branchTopY + i * (NODE_H + V_GAP) });
    }

    // AH branch: right column, vertically stacked
    const ahX = H_GAP + NODE_W;
    for (let i = 0; i < ahChain.length; i++) {
        positions.set(ahChain[i], { x: ahX, y: branchTopY + i * (NODE_H + V_GAP) });
    }

    // Align terminal nodes (Voicemails) at the same Y — the maximum of the two
    const bhTermY = positions.get(BH_TERMINAL)?.y ?? branchTopY;
    const ahTermY = positions.get(AH_TERMINAL)?.y ?? branchTopY;
    const terminalY = Math.max(bhTermY, ahTermY);
    if (positions.has(BH_TERMINAL)) positions.set(BH_TERMINAL, { x: positions.get(BH_TERMINAL)!.x, y: terminalY });
    if (positions.has(AH_TERMINAL)) positions.set(AH_TERMINAL, { x: positions.get(AH_TERMINAL)!.x, y: terminalY });

    // Hours Check: centered above the two columns
    const leftX = bhX;
    const rightX = ahX;
    const centerX = (leftX + rightX) / 2;
    positions.set(HOURS_CHECK, { x: centerX, y: 0 });

    // Any nodes not in either chain (shouldn't happen normally, but fallback)
    const positioned = new Set(positions.keys());
    const unpositioned = nodes.filter(n => !positioned.has(n.id));
    if (unpositioned.length > 0) {
        // Use ELK for any remaining nodes
        const graph = {
            id: 'root',
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.spacing.nodeNode': '60',
                'elk.layered.spacing.nodeNodeBetweenLayers': '80',
            },
            children: unpositioned.map(n => ({ id: n.id, width: NODE_W, height: NODE_H })),
            edges: edges.filter(e =>
                !positioned.has(e.source) && !positioned.has(e.target) &&
                unpositioned.some(n => n.id === e.source) && unpositioned.some(n => n.id === e.target)
            ).map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
        };
        try {
            const laid = await elk.layout(graph);
            for (const n of unpositioned) {
                const elkN = laid.children?.find(c => c.id === n.id);
                positions.set(n.id, { x: (elkN?.x ?? 0) + centerX, y: (elkN?.y ?? 0) + terminalY + NODE_H + V_GAP });
            }
        } catch {
            for (const n of unpositioned) {
                positions.set(n.id, n.position);
            }
        }
    }

    return {
        nodes: nodes.map(n => ({
            ...n,
            position: positions.get(n.id) || n.position,
        })),
        edges,
    };
}

import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

export async function layoutWithElkLayered(
    nodes: { id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number } }[],
    edges: { id: string; source: string; target: string }[],
) {
    const graph = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'DOWN',
            'elk.spacing.nodeNode': '60',
            'elk.layered.spacing.nodeNodeBetweenLayers': '80',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
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
            const elkNode = laid.children?.find(c => c.id === n.id);
            return { ...n, position: { x: elkNode?.x ?? n.position.x, y: elkNode?.y ?? n.position.y } };
        }),
        edges,
    };
}

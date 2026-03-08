import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    ReactFlow, Background, Controls, MiniMap,
    useNodesState, useEdgesState, addEdge, MarkerType,
    type Node, type Edge, type Connection, type NodeTypes,
    Handle, Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Upload, AlertCircle, CheckCircle } from 'lucide-react';
import { callFlowApi } from '../../services/callFlowMockApi';
import { NODE_KIND_META, type CallFlowNodeKind } from '../../types/callFlowTypes';
import type { CallFlowVersion, CallFlowNode as CFNode, CallFlowTransition } from '../../types/callFlow';
import { layoutWithElkLayered } from '../../utils/elkLayeredLayout';

// ─── Types for node data ──────────────────────────────────────────────────────

type FlowNodeData = {
    label: string;
    kind: string;
    isInitial?: boolean;
    config?: Record<string, unknown>;
    isRoot?: boolean;
    isFinal?: boolean;
    order?: number;
};

// ─── Custom Node ──────────────────────────────────────────────────────────────

function FlowNodeComponent({ data, selected }: { data: FlowNodeData; selected?: boolean }) {
    const meta = NODE_KIND_META[data.kind as CallFlowNodeKind] || { label: data.kind, color: '#6b7280', icon: '?' };
    return (
        <div style={{
            minWidth: 180, padding: '10px 14px', borderRadius: 10,
            background: '#fff', border: `2px solid ${selected ? '#6366f1' : meta.color}`,
            boxShadow: selected ? `0 0 0 3px ${meta.color}33` : '0 1px 4px rgba(0,0,0,0.08)',
            cursor: 'grab', transition: 'box-shadow 0.15s',
        }}>
            <Handle type="target" position={Position.Top} style={{ background: meta.color, width: 8, height: 8 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>{meta.icon}</span>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{data.label}</div>
                    <div style={{ fontSize: 10, color: meta.color, fontWeight: 500 }}>{meta.label}</div>
                </div>
            </div>
            {data.kind !== 'final' && (
                <Handle type="source" position={Position.Bottom} style={{ background: meta.color, width: 8, height: 8 }} />
            )}
        </div>
    );
}

const nodeTypes: NodeTypes = { flowNode: FlowNodeComponent };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function graphToReactFlow(states: CFNode[], transitions: CallFlowTransition[]) {
    const nodes: Node<FlowNodeData>[] = states.map((s, i) => ({
        id: s.id, type: 'flowNode' as const, position: { x: 200, y: i * 120 },
        data: {
            label: s.name, kind: s.kind, isInitial: s.isInitial, config: s.config,
            isRoot: s.isInitial, isFinal: s.kind === 'final', order: i,
        },
    }));
    const edges: Edge[] = transitions.map(t => ({
        id: t.id, source: t.from_state_id, target: t.to_state_id, type: 'smoothstep',
        label: t.label || t.event_key, markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 },
        labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' },
    }));
    return { nodes, edges };
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export default function CallFlowBuilderPage() {
    const { flowId, versionId } = useParams<{ flowId: string; versionId: string }>();
    const navigate = useNavigate();
    const [version, setVersion] = useState<CallFlowVersion | null>(null);
    const [loading, setLoading] = useState(true);
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [selectedNode, setSelectedNode] = useState<Node<FlowNodeData> | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
    const [saving, setSaving] = useState(false);

    // Load version
    useEffect(() => {
        if (!flowId) return;
        (async () => {
            const versions = await callFlowApi.getVersions(flowId);
            const v = versionId ? versions.find(vv => vv.id === versionId) : versions[0];
            if (v) {
                setVersion(v);
                const { nodes: n, edges: e } = graphToReactFlow(v.graph.states, v.graph.transitions);
                // Auto-layout with ELK
                try {
                    const laid = await layoutWithElkLayered(n as any, e as any);
                    setNodes(laid.nodes as any);
                    setEdges(laid.edges as any);
                } catch {
                    setNodes(n as any);
                    setEdges(e as any);
                }
            }
            setLoading(false);
        })();
    }, [flowId, versionId]);  // eslint-disable-line react-hooks/exhaustive-deps

    const onConnect = useCallback((params: Connection) => {
        setEdges(eds => addEdge({ ...params, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, label: 'NEW' }, eds) as any);
    }, [setEdges]);

    const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
        setSelectedNode(node as Node<FlowNodeData>);
        setSelectedEdge(null);
    }, []);
    const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
        setSelectedEdge(edge);
        setSelectedNode(null);
    }, []);
    const onPaneClick = useCallback(() => { setSelectedNode(null); setSelectedEdge(null); }, []);

    const handleSave = useCallback(async () => {
        if (!flowId || !version) return;
        setSaving(true);
        await callFlowApi.saveDraft(flowId, version.graph);
        setSaving(false);
    }, [flowId, version]);

    const addNode = useCallback((kind: CallFlowNodeKind) => {
        const meta = NODE_KIND_META[kind];
        const id = `n-${Date.now()}`;
        const newNode: Node<FlowNodeData> = {
            id, type: 'flowNode', position: { x: 300 + Math.random() * 200, y: 200 + Math.random() * 200 },
            data: { label: meta.label, kind, isRoot: false, isFinal: kind === 'final' },
        };
        setNodes(nds => [...nds, newNode] as any);
    }, [setNodes]);

    const deleteNode = useCallback(() => {
        if (!selectedNode) return;
        const id = selectedNode.id;
        setNodes(nds => (nds as any[]).filter((n: any) => n.id !== id) as any);
        setEdges(eds => (eds as any[]).filter((e: any) => e.source !== id && e.target !== id) as any);
        setSelectedNode(null);
    }, [selectedNode, setNodes, setEdges]);

    const deleteEdge = useCallback(() => {
        if (!selectedEdge) return;
        const id = selectedEdge.id;
        setEdges(eds => (eds as any[]).filter((e: any) => e.id !== id) as any);
        setSelectedEdge(null);
    }, [selectedEdge, setEdges]);

    const validation = version?.validation;
    const errCount = validation?.errors.length || 0;
    const warnCount = validation?.warnings.length || 0;

    if (loading) return <div style={{ padding: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}><div style={{ width: 32, height: 32, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
            {/* Top Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={() => navigate(`/settings/telephony/call-flows/${flowId}`)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><ArrowLeft size={14} />Back</button>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>Flow Builder — v{version?.version_number}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: version?.status === 'draft' ? '#fef3c7' : '#d1fae5', color: version?.status === 'draft' ? '#92400e' : '#065f46' }}>{version?.status}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {errCount > 0 && <span style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 3 }}><AlertCircle size={13} />{errCount} errors</span>}
                    {warnCount > 0 && <span style={{ fontSize: 11, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 3 }}><AlertCircle size={13} />{warnCount} warnings</span>}
                    {errCount === 0 && warnCount === 0 && <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 3 }}><CheckCircle size={13} />Valid</span>}
                    <button onClick={handleSave} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 12, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}><Save size={13} />{saving ? 'Saving...' : 'Save Draft'}</button>
                    <button disabled style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 12, fontWeight: 500, background: errCount > 0 ? '#e5e7eb' : '#10b981', color: '#fff', border: 'none', borderRadius: 6, cursor: errCount > 0 ? 'not-allowed' : 'pointer' }}><Upload size={13} />Publish</button>
                </div>
            </div>

            {/* Main Content: Palette + Canvas + Inspector */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Left Palette */}
                <div style={{ width: 200, background: '#f9fafb', borderRight: '1px solid #e5e7eb', padding: 12, overflowY: 'auto', flexShrink: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Node Palette</div>
                    {(Object.entries(NODE_KIND_META) as [CallFlowNodeKind, (typeof NODE_KIND_META)['start']][]).map(([kind, meta]) => (
                        <button key={kind} onClick={() => addNode(kind)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', fontSize: 12, fontWeight: 500, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', marginBottom: 4, color: '#374151', textAlign: 'left' }}>
                            <span style={{ fontSize: 14 }}>{meta.icon}</span>
                            <span>{meta.label}</span>
                        </button>
                    ))}
                </div>

                {/* Center Canvas */}
                <div style={{ flex: 1 }}>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeClick={onNodeClick}
                        onEdgeClick={onEdgeClick}
                        onPaneClick={onPaneClick}
                        nodeTypes={nodeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.3 }}
                        deleteKeyCode="Delete"
                    >
                        <Background gap={20} size={1} />
                        <Controls />
                        <MiniMap style={{ width: 120, height: 90 }} />
                    </ReactFlow>
                </div>

                {/* Right Inspector */}
                <div style={{ width: 280, background: '#fff', borderLeft: '1px solid #e5e7eb', padding: 16, overflowY: 'auto', flexShrink: 0 }}>
                    {!selectedNode && !selectedEdge && (
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Flow Properties</div>
                            <div style={{ fontSize: 13, color: '#374151' }}>
                                <div style={{ marginBottom: 8 }}><strong>Nodes:</strong> {nodes.length}</div>
                                <div style={{ marginBottom: 8 }}><strong>Edges:</strong> {edges.length}</div>
                                <div style={{ marginBottom: 8 }}><strong>Version:</strong> v{version?.version_number}</div>
                                <div><strong>Status:</strong> {version?.status}</div>
                            </div>
                            {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
                                <div style={{ marginTop: 16 }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 8 }}>Problems</div>
                                    {validation.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: '#ef4444', marginBottom: 4 }}>✗ {e.message}</div>)}
                                    {validation.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: '#f59e0b', marginBottom: 4 }}>⚠ {w.message}</div>)}
                                </div>
                            )}
                        </div>
                    )}

                    {selectedNode && (
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Node Inspector</div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Name</label>
                                <input value={String(selectedNode.data?.label || '')} readOnly style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                            </div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Kind</label>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                                    <span>{NODE_KIND_META[(selectedNode.data?.kind as CallFlowNodeKind)]?.icon}</span>
                                    <span style={{ fontWeight: 500 }}>{NODE_KIND_META[(selectedNode.data?.kind as CallFlowNodeKind)]?.label}</span>
                                </div>
                            </div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>ID</label>
                                <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{selectedNode.id}</div>
                            </div>
                            {selectedNode.data?.config && (
                                <div>
                                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Config</label>
                                    <pre style={{ fontSize: 10, background: '#f9fafb', padding: 8, borderRadius: 6, overflow: 'auto', maxHeight: 200 }}>{JSON.stringify(selectedNode.data.config, null, 2)}</pre>
                                </div>
                            )}
                            <button onClick={deleteNode} style={{ marginTop: 16, width: '100%', padding: '8px', fontSize: 12, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer' }}>Delete Node</button>
                        </div>
                    )}

                    {selectedEdge && (
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Edge Inspector</div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>From → To</label>
                                <div style={{ fontSize: 12, fontFamily: 'monospace' }}>{selectedEdge.source} → {selectedEdge.target}</div>
                            </div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Label</label>
                                <div style={{ fontSize: 13, fontWeight: 500 }}>{String(selectedEdge.label || '—')}</div>
                            </div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>ID</label>
                                <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{selectedEdge.id}</div>
                            </div>
                            <button onClick={deleteEdge} style={{ marginTop: 16, width: '100%', padding: '8px', fontSize: 12, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer' }}>Delete Edge</button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

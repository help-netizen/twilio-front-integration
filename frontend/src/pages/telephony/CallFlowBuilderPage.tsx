import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    ReactFlow, Background, Controls, MiniMap,
    useNodesState, useEdgesState, addEdge, MarkerType,
    type Node, type Edge, type Connection, type NodeTypes,
    Handle, Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Upload, AlertCircle, CheckCircle, Undo2, Redo2, LayoutGrid, Search, Trash2, X } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { NODE_KIND_META, type CallFlowNodeKind, type CallFlow, type CallFlowNode as CFNode, type CallFlowTransition } from '../../types/telephony';
import { layoutWithElkLayered } from '../../utils/elkLayout';

// ─── Types ────────────────────────────────────────────────────────────────────
type FlowNodeData = {
    label: string; kind: string; isInitial?: boolean; isProtected?: boolean;
    system?: boolean; immutable?: boolean; uiTerminal?: boolean; hidden?: boolean;
    labelExpr?: string; groupRef?: string;
    config?: Record<string, unknown>;
};

// ── SCXML generator (blanc namespace) ────────────────────────────────────────
function graphToScxml(allNodes: Node<FlowNodeData>[], allEdges: Edge[]): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const initialNode = allNodes.find(n => n.data?.isInitial) || allNodes[0];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<scxml\n  xmlns="http://www.w3.org/2005/07/scxml"\n  xmlns:blanc="https://blanc.app/fsm"\n  version="1.0" datamodel="ecmascript"\n  initial="${esc(initialNode?.id || '')}"\n  blanc:machineType="call_flow" blanc:schemaVersion="2" blanc:skeleton="call_flow_skeleton_v2"\n>\n`;
    xml += `  <datamodel>\n    <data id="isBusinessHours" expr="false" />\n    <data id="currentGroupName" expr="'Current Group'" />\n  </datamodel>\n\n`;
    for (const node of allNodes) {
        const d = node.data;
        const kind = d?.kind || 'unknown';
        const outEdges = allEdges.filter(e => e.source === node.id);
        const isFinal = kind === 'final';
        const tag = isFinal ? 'final' : 'state';
        const ba: string[] = [`blanc:kind="${esc(kind)}"`];
        if (d?.labelExpr) ba.push(`blanc:labelExpr="${esc(d.labelExpr)}"`);
        else ba.push(`blanc:label="${esc(String(d?.label || ''))}"`);
        if (d?.groupRef) ba.push(`blanc:groupRef="${esc(d.groupRef)}"`);
        if (d?.system) ba.push(`blanc:system="true"`);
        if (d?.immutable) ba.push(`blanc:immutable="true"`);
        if (d?.isProtected) ba.push(`blanc:deletable="false"`);
        if (d?.uiTerminal) ba.push(`blanc:uiTerminal="true"`);
        if (d?.hidden) ba.push(`blanc:hidden="true"`);
        if (isFinal && outEdges.length === 0) {
            xml += `  <${tag} id="${esc(node.id)}" ${ba.join(' ')} />\n\n`;
        } else {
            xml += `  <${tag}\n    id="${esc(node.id)}"\n    ${ba.join('\n    ')}\n  >\n`;
            for (const edge of outEdges) {
                const ed = (edge as any).data || {};
                const ta: string[] = [];
                if (ed.condExpr) ta.push(`cond="${esc(ed.condExpr)}"`);
                if (ed.event_key) ta.push(`event="${esc(ed.event_key)}"`);
                ta.push(`target="${esc(edge.target)}"`);
                if (ed.system) ta.push(`blanc:system="true"`);
                if (ed.immutable) ta.push(`blanc:immutable="true"`);
                if (ed.hidden) ta.push(`blanc:hidden="true"`);
                if (ed.deletable === false) ta.push(`blanc:deletable="false"`);
                if (ed.edgeLabel) ta.push(`blanc:edgeLabel="${esc(ed.edgeLabel)}"`);
                if (ed.branchKey) ta.push(`blanc:branchKey="${esc(ed.branchKey)}"`);
                if (ed.edgeRole) ta.push(`blanc:edgeRole="${esc(ed.edgeRole)}"`);
                if (ed.insertable) ta.push(`blanc:insertable="true"`);
                if (ed.insertMode) ta.push(`blanc:insertMode="${esc(ed.insertMode)}"`);
                xml += `    <transition ${ta.join(' ')} />\n`;
            }
            xml += `  </${tag}>\n\n`;
        }
    }
    xml += `</scxml>`;
    return xml;
}

// ─── Undo/Redo ────────────────────────────────────────────────────────────────
interface Snapshot { nodes: Node<FlowNodeData>[]; edges: Edge[] }
function useUndoRedo(
    nodes: Node<FlowNodeData>[], edges: Edge[],
    setNodes: (n: Node<FlowNodeData>[] | ((p: Node<FlowNodeData>[]) => Node<FlowNodeData>[])) => void,
    setEdges: (e: Edge[] | ((p: Edge[]) => Edge[])) => void,
) {
    const undoStack = useRef<Snapshot[]>([]);
    const redoStack = useRef<Snapshot[]>([]);
    const last = useRef('');
    const push = useCallback(() => {
        const k = JSON.stringify({ n: nodes.map(n => n.id), e: edges.map(e => e.id) });
        if (k === last.current) return;
        last.current = k;
        undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
        redoStack.current = [];
    }, [nodes, edges]);
    const undo = useCallback(() => {
        const s = undoStack.current.pop(); if (!s) return;
        redoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
        setNodes(s.nodes as any); setEdges(s.edges as any);
        last.current = JSON.stringify({ n: s.nodes.map(n => n.id), e: s.edges.map(e => e.id) });
    }, [nodes, edges, setNodes, setEdges]);
    const redo = useCallback(() => {
        const s = redoStack.current.pop(); if (!s) return;
        undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
        setNodes(s.nodes as any); setEdges(s.edges as any);
        last.current = JSON.stringify({ n: s.nodes.map(n => n.id), e: s.edges.map(e => e.id) });
    }, [nodes, edges, setNodes, setEdges]);
    return { push, undo, redo, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 };
}

// ─── Custom Node ──────────────────────────────────────────────────────────────
function FlowNodeComponent({ data, selected }: { data: FlowNodeData; selected?: boolean }) {
    const meta = NODE_KIND_META[data.kind as CallFlowNodeKind] || { label: data.kind, color: '#6b7280', icon: '?' };
    const isStart = data.kind === 'start';
    return (
        <div style={{
            minWidth: 180, padding: '10px 14px', borderRadius: 10,
            background: '#fff', border: `2px solid ${selected ? '#6366f1' : meta.color}`,
            boxShadow: selected ? `0 0 0 3px ${meta.color}33` : '0 1px 4px rgba(0,0,0,0.08)',
            cursor: 'grab', transition: 'box-shadow 0.15s',
        }}>
            {!isStart && <Handle type="target" position={Position.Top} style={{ background: meta.color, width: 8, height: 8 }} />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>{meta.icon}</span>
                <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{data.label}</div>
                    <div style={{ fontSize: 10, color: meta.color, fontWeight: 500 }}>{meta.label}</div>
                </div>
            </div>
            {data.kind !== 'hangup' && data.kind !== 'voicemail' && (
                <Handle type="source" position={Position.Bottom} style={{ background: meta.color, width: 8, height: 8 }} />
            )}
        </div>
    );
}
const nodeTypes: NodeTypes = { flowNode: FlowNodeComponent };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function graphToReactFlow(states: CFNode[], transitions: CallFlowTransition[]) {
    const visibleStates = states.filter(s => !s.hidden);
    const visibleTransitions = transitions.filter(t => !t.hidden);
    const nodes: Node<FlowNodeData>[] = visibleStates.map((s, i) => ({
        id: s.id, type: 'flowNode' as const, position: { x: 200, y: i * 120 },
        data: {
            label: s.name, kind: s.kind, isInitial: s.isInitial, isProtected: s.protected,
            system: s.system, immutable: s.immutable, uiTerminal: s.uiTerminal, hidden: s.hidden,
            labelExpr: s.labelExpr, groupRef: s.groupRef, config: s.config,
        },
    }));
    const edges: Edge[] = visibleTransitions.map(t => ({
        id: t.id, source: t.from_state_id, target: t.to_state_id, type: 'smoothstep',
        label: t.label || t.edgeLabel || t.event_key,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' },
        data: {
            system: t.system, immutable: t.immutable, deletable: t.deletable, hidden: t.hidden,
            insertable: t.insertable, insertMode: t.insertMode, edgeLabel: t.edgeLabel,
            branchKey: t.branchKey, edgeRole: t.edgeRole, transitionMode: t.transitionMode,
            condExpr: t.condExpr, event_key: t.event_key
        },
    }));
    return { nodes, edges };
}
function graphHiddenElements(states: CFNode[], transitions: CallFlowTransition[]) {
    const nodes: Node<FlowNodeData>[] = states.filter(s => s.hidden).map(s => ({
        id: s.id, type: 'flowNode' as const, position: { x: 0, y: 0 },
        data: { label: s.name, kind: s.kind, system: s.system, hidden: s.hidden, config: s.config },
    }));
    const edges: Edge[] = transitions.filter(t => t.hidden).map(t => ({
        id: t.id, source: t.from_state_id, target: t.to_state_id, type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { system: t.system, hidden: t.hidden, edgeRole: t.edgeRole, transitionMode: t.transitionMode, event_key: t.event_key, condExpr: t.condExpr },
    }));
    return { nodes, edges };
}

// ─── Builder ──────────────────────────────────────────────────────────────────
export default function CallFlowBuilderPage() {
    const { groupId } = useParams<{ groupId: string }>();
    // Each User Group has exactly one Call Flow — map groupId to flowId
    const flowId = groupId ? `cf-${groupId.replace('ug-', '')}` : undefined;
    const navigate = useNavigate();
    const [flow, setFlow] = useState<CallFlow | null>(null);
    const [loading, setLoading] = useState(true);
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const hiddenNodesRef = useRef<Node<FlowNodeData>[]>([]);
    const hiddenEdgesRef = useRef<Edge[]>([]);
    const [selectedNode, setSelectedNode] = useState<Node<FlowNodeData> | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
    const [saving, setSaving] = useState(false);
    const [leftTab, setLeftTab] = useState<'palette' | 'outline'>('palette');
    const [outlineSearch, setOutlineSearch] = useState('');
    const [showPublishModal, setShowPublishModal] = useState(false);
    const [publishNote, setPublishNote] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ type: 'node' | 'edge'; id: string; label: string } | null>(null);

    const { push: pushSnap, undo, redo, canUndo, canRedo } = useUndoRedo(nodes as any, edges, setNodes as any, setEdges as any);

    // Load flow (no versioning — single graph per flow)
    useEffect(() => {
        if (!flowId) return;
        (async () => {
            const f = await telephonyApi.getFlow(flowId);
            if (f) {
                setFlow(f);
                const { nodes: n, edges: e } = graphToReactFlow(f.graph.states, f.graph.transitions);
                const hid = graphHiddenElements(f.graph.states, f.graph.transitions);
                hiddenNodesRef.current = hid.nodes;
                hiddenEdgesRef.current = hid.edges;
                try { const laid = await layoutWithElkLayered(n as any, e as any); setNodes(laid.nodes as any); setEdges(laid.edges as any); }
                catch { setNodes(n as any); setEdges(e as any); }
            }
            setLoading(false);
        })();
    }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keyboard shortcuts
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
            if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [undo, redo]);

    const onConnect = useCallback((p: Connection) => {
        pushSnap();
        setEdges(eds => addEdge({ ...p, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, label: 'transition', style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' } }, eds) as any);
    }, [setEdges, pushSnap]);

    const onNodeClick = useCallback((_: React.MouseEvent, n: Node) => { setSelectedNode(n as Node<FlowNodeData>); setSelectedEdge(null); }, []);
    const onEdgeClick = useCallback((_: React.MouseEvent, e: Edge) => { setSelectedEdge(e); setSelectedNode(null); }, []);
    const onPaneClick = useCallback(() => { setSelectedNode(null); setSelectedEdge(null); }, []);

    const handleSave = useCallback(async () => {
        if (!flowId || !flow) return;
        setSaving(true);
        await telephonyApi.saveFlow(flowId, flow.graph);
        setSaving(false);
    }, [flowId, flow]);

    const addNode = useCallback((kind: CallFlowNodeKind) => {
        pushSnap();
        const meta = NODE_KIND_META[kind];
        const id = `n-${Date.now()}`;
        const newNode: Node<FlowNodeData> = {
            id, type: 'flowNode', position: { x: 300 + Math.random() * 200, y: 200 + Math.random() * 200 },
            data: { label: meta.label, kind },
        };
        setNodes(nds => [...nds, newNode] as any);
    }, [setNodes, pushSnap]);

    const confirmDelete = useCallback(() => {
        if (!showDeleteConfirm) return;
        pushSnap();
        if (showDeleteConfirm.type === 'node') {
            const id = showDeleteConfirm.id;
            setNodes(nds => (nds as any[]).filter((n: any) => n.id !== id) as any);
            setEdges(eds => (eds as any[]).filter((e: any) => e.source !== id && e.target !== id) as any);
            setSelectedNode(null);
        } else {
            const id = showDeleteConfirm.id;
            setEdges(eds => (eds as any[]).filter((e: any) => e.id !== id) as any);
            setSelectedEdge(null);
        }
        setShowDeleteConfirm(null);
    }, [showDeleteConfirm, setNodes, setEdges, pushSnap]);

    const runAutoLayout = useCallback(async () => {
        pushSnap();
        try { const laid = await layoutWithElkLayered(nodes as any, edges as any); setNodes(laid.nodes as any); setEdges(laid.edges as any); }
        catch { /* keep */ }
    }, [nodes, edges, setNodes, setEdges, pushSnap]);

    const updateNodeName = useCallback((id: string, name: string) => {
        pushSnap();
        setNodes(nds => (nds as any[]).map((n: any) => n.id === id ? { ...n, data: { ...n.data, label: name } } : n) as any);
        setSelectedNode(p => p && p.id === id ? { ...p, data: { ...p.data, label: name } } : p);
    }, [setNodes, pushSnap]);

    const updateEdgeLabel = useCallback((id: string, label: string) => {
        pushSnap();
        setEdges(eds => (eds as any[]).map((e: any) => e.id === id ? { ...e, label } : e) as any);
        setSelectedEdge(p => p && p.id === id ? { ...p, label } : p);
    }, [setEdges, pushSnap]);

    const validation = flow?.validation;
    const errCount = validation?.errors.length || 0;
    const warnCount = validation?.warnings.length || 0;
    const getNodeLabel = (id: string) => (nodes as any[]).find((n: any) => n.id === id)?.data?.label || id;

    const outlineNodes = (nodes as any[]).filter((n: any) =>
        !outlineSearch || (n.data?.label || '').toLowerCase().includes(outlineSearch.toLowerCase())
    );

    // Filter palette: no 'start' since flow always has exactly one start node
    const paletteKinds = (Object.entries(NODE_KIND_META) as [CallFlowNodeKind, (typeof NODE_KIND_META)['start']][])
        .filter(([kind]) => kind !== 'start' && kind !== 'final');

    if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}><div style={{ width: 32, height: 32, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={() => navigate(`/settings/telephony/user-groups/${groupId}`)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><ArrowLeft size={14} />Back to Group</button>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{flow?.name || 'Flow Builder'}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: flow?.status === 'draft' ? '#fef3c7' : '#d1fae5', color: flow?.status === 'draft' ? '#92400e' : '#065f46' }}>{flow?.status}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={undo} disabled={!canUndo} title="Undo ⌘Z" style={{ padding: '5px 8px', fontSize: 12, background: canUndo ? '#f3f4f6' : '#fafafa', color: canUndo ? '#374151' : '#d1d5db', border: '1px solid #e5e7eb', borderRadius: 6, cursor: canUndo ? 'pointer' : 'default', display: 'flex', alignItems: 'center' }}><Undo2 size={13} /></button>
                    <button onClick={redo} disabled={!canRedo} title="Redo ⌘⇧Z" style={{ padding: '5px 8px', fontSize: 12, background: canRedo ? '#f3f4f6' : '#fafafa', color: canRedo ? '#374151' : '#d1d5db', border: '1px solid #e5e7eb', borderRadius: 6, cursor: canRedo ? 'pointer' : 'default', display: 'flex', alignItems: 'center' }}><Redo2 size={13} /></button>
                    <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 4px' }} />
                    <button onClick={runAutoLayout} title="Auto-layout (ELK)" style={{ padding: '5px 8px', fontSize: 12, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}><LayoutGrid size={13} />Layout</button>
                    <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 4px' }} />
                    {errCount > 0 && <span style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 3 }}><AlertCircle size={13} />{errCount} errors</span>}
                    {warnCount > 0 && <span style={{ fontSize: 11, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 3 }}><AlertCircle size={13} />{warnCount} warnings</span>}
                    {errCount === 0 && warnCount === 0 && <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 3 }}><CheckCircle size={13} />Valid</span>}
                    <div style={{ width: 1, height: 20, background: '#e5e7eb', margin: '0 4px' }} />
                    <button onClick={handleSave} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 12, fontWeight: 500, background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}><Save size={13} />{saving ? 'Saving...' : 'Save'}</button>
                    <button onClick={() => errCount === 0 && setShowPublishModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 12, fontWeight: 500, background: errCount > 0 ? '#e5e7eb' : '#10b981', color: '#fff', border: 'none', borderRadius: 6, cursor: errCount > 0 ? 'not-allowed' : 'pointer' }}><Upload size={13} />Publish</button>
                </div>
            </div>

            {/* Main */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* Left Panel */}
                <div style={{ width: 220, background: '#f9fafb', borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                    <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
                        {(['palette', 'outline'] as const).map(t => (
                            <button key={t} onClick={() => setLeftTab(t)} style={{
                                flex: 1, padding: 8, fontSize: 11, fontWeight: leftTab === t ? 600 : 400,
                                color: leftTab === t ? '#6366f1' : '#6b7280', background: 'none', border: 'none',
                                borderBottom: leftTab === t ? '2px solid #6366f1' : '2px solid transparent', cursor: 'pointer',
                            }}>{t === 'palette' ? 'Palette' : 'Outline'}</button>
                        ))}
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
                        {leftTab === 'palette' && (
                            <>
                                <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Add Node</div>
                                {paletteKinds.map(([kind, meta]) => (
                                    <button key={kind} onClick={() => addNode(kind)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', fontSize: 12, fontWeight: 500, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', marginBottom: 3, color: '#374151', textAlign: 'left' }}>
                                        <span style={{ fontSize: 14 }}>{meta.icon}</span><span>{meta.label}</span>
                                    </button>
                                ))}
                            </>
                        )}
                        {leftTab === 'outline' && (
                            <>
                                <div style={{ position: 'relative', marginBottom: 8 }}>
                                    <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                                    <input value={outlineSearch} onChange={e => setOutlineSearch(e.target.value)} placeholder="Search states..." style={{ width: '100%', padding: '6px 8px 6px 28px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 11, outline: 'none' }} />
                                </div>
                                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 6 }}>{outlineNodes.length} states</div>
                                {outlineNodes.map((n: any) => {
                                    const meta = NODE_KIND_META[n.data?.kind as CallFlowNodeKind] || { color: '#6b7280', icon: '?' };
                                    const isSel = selectedNode?.id === n.id;
                                    return (
                                        <button key={n.id} onClick={() => { setSelectedNode(n); setSelectedEdge(null); }} style={{
                                            display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', fontSize: 11,
                                            fontWeight: isSel ? 600 : 400, background: isSel ? '#ede9fe' : 'transparent',
                                            color: isSel ? '#6366f1' : '#374151', border: 'none', borderRadius: 4, cursor: 'pointer', marginBottom: 2, textAlign: 'left',
                                        }}>
                                            <span style={{ color: meta.color, fontSize: 12 }}>{meta.icon}</span>
                                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.data?.label}</span>
                                        </button>
                                    );
                                })}
                            </>
                        )}
                    </div>
                </div>

                {/* Canvas */}
                <div style={{ flex: 1 }}>
                    <ReactFlow
                        nodes={nodes} edges={edges}
                        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                        onConnect={onConnect} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={onPaneClick}
                        nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3 }} deleteKeyCode="Delete"
                    >
                        <Background gap={20} size={1} /><Controls /><MiniMap style={{ width: 120, height: 90 }} />
                    </ReactFlow>
                </div>

                {/* Inspector */}
                <div style={{ width: 300, background: '#fff', borderLeft: '1px solid #e5e7eb', padding: 16, overflowY: 'auto', flexShrink: 0 }}>
                    {!selectedNode && !selectedEdge && (
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Flow Properties</div>
                            <div style={{ fontSize: 13, color: '#374151', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Nodes</span><strong>{nodes.length}</strong></div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Edges</span><strong>{edges.length}</strong></div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#6b7280' }}>Status</span><strong>{flow?.status}</strong></div>
                            </div>
                            {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
                                <div style={{ marginTop: 16 }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 8 }}>Problems</div>
                                    {validation.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: '#ef4444', marginBottom: 4, padding: '4px 8px', background: '#fef2f2', borderRadius: 4 }}>✗ {e.message}</div>)}
                                    {validation.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: '#f59e0b', marginBottom: 4, padding: '4px 8px', background: '#fffbeb', borderRadius: 4 }}>⚠ {w.message}</div>)}
                                </div>
                            )}
                            {/* SCXML */}
                            <div style={{ marginTop: 20 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>SCXML</div>
                                    <button onClick={() => { navigator.clipboard.writeText(graphToScxml([...nodes as Node<FlowNodeData>[], ...hiddenNodesRef.current], [...edges, ...hiddenEdgesRef.current])); }}
                                        title="Copy SCXML"
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2, borderRadius: 4 }}
                                        onMouseEnter={e => (e.currentTarget.style.color = '#6366f1')}
                                        onMouseLeave={e => (e.currentTarget.style.color = '#9ca3af')}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                                    </button>
                                </div>
                                <pre style={{ fontSize: 9, lineHeight: 1.5, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, overflow: 'auto', maxHeight: 300, whiteSpace: 'pre', color: '#374151', fontFamily: 'ui-monospace, monospace', margin: 0 }}>{graphToScxml([...nodes as Node<FlowNodeData>[], ...hiddenNodesRef.current], [...edges, ...hiddenEdgesRef.current])}</pre>
                            </div>
                        </div>
                    )}
                    {selectedNode && (
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Node Inspector</div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Name</label>
                                <input value={String(selectedNode.data?.label || '')} onChange={e => updateNodeName(selectedNode.id, e.target.value)} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
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
                                <div style={{ marginBottom: 12 }}>
                                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Config</label>
                                    <pre style={{ fontSize: 10, background: '#f9fafb', padding: 8, borderRadius: 6, overflow: 'auto', maxHeight: 200 }}>{JSON.stringify(selectedNode.data.config, null, 2)}</pre>
                                </div>
                            )}
                            {/* Start node is undeletable */}
                            {selectedNode.data?.kind !== 'start' && (
                                <button onClick={() => setShowDeleteConfirm({ type: 'node', id: selectedNode.id, label: String(selectedNode.data?.label || selectedNode.id) })}
                                    style={{ marginTop: 12, width: '100%', padding: 8, fontSize: 12, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                    <Trash2 size={13} />Delete Node
                                </button>
                            )}
                        </div>
                    )}
                    {selectedEdge && (
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Edge Inspector</div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>From → To</label>
                                <div style={{ fontSize: 12 }}><span style={{ fontWeight: 500 }}>{getNodeLabel(selectedEdge.source)}</span><span style={{ color: '#9ca3af' }}> → </span><span style={{ fontWeight: 500 }}>{getNodeLabel(selectedEdge.target)}</span></div>
                            </div>
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Label / Event Key</label>
                                <input value={String(selectedEdge.label || '')} onChange={e => updateEdgeLabel(selectedEdge.id, e.target.value)} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                            </div>
                            <button onClick={() => setShowDeleteConfirm({ type: 'edge', id: selectedEdge.id, label: `${getNodeLabel(selectedEdge.source)} → ${getNodeLabel(selectedEdge.target)}` })}
                                style={{ marginTop: 12, width: '100%', padding: 8, fontSize: 12, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                <Trash2 size={13} />Delete Edge
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Delete Confirm */}
            {showDeleteConfirm && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowDeleteConfirm(null)}>
                    <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Delete {showDeleteConfirm.type}?</h3>
                            <button onClick={() => setShowDeleteConfirm(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 0 }}><X size={18} /></button>
                        </div>
                        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 8px' }}>Delete <strong>{showDeleteConfirm.label}</strong>?</p>
                        {showDeleteConfirm.type === 'node' && <p style={{ fontSize: 12, color: '#f59e0b', margin: '0 0 16px' }}>⚠ All connected edges will also be removed.</p>}
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button onClick={() => setShowDeleteConfirm(null)} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                            <button onClick={confirmDelete} style={{ padding: '8px 16px', fontSize: 13, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Delete</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Publish Modal */}
            {showPublishModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowPublishModal(false)}>
                    <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 440, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Publish Flow</h3>
                            <button onClick={() => setShowPublishModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 0 }}><X size={18} /></button>
                        </div>
                        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>Publishing makes this flow <strong>live</strong> and routes calls through it.</p>
                        <div style={{ marginBottom: 16 }}>
                            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Change Note (optional)</label>
                            <textarea value={publishNote} onChange={e => setPublishNote(e.target.value)} rows={3} placeholder="Describe what changed..." style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'none' }} />
                        </div>
                        <div style={{ padding: '10px 12px', background: '#f0fdf4', borderRadius: 8, marginBottom: 16 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle size={14} style={{ color: '#10b981' }} /><span style={{ fontSize: 12, fontWeight: 500, color: '#065f46' }}>Validation passed — {nodes.length} states, {edges.length} transitions</span></div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button onClick={() => setShowPublishModal(false)} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                            <button onClick={() => { setShowPublishModal(false); setPublishNote(''); }} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#10b981', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Publish Now</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

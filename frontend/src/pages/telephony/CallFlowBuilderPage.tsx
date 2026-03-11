import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    ReactFlow, Background, Controls, MiniMap,
    useNodesState, useEdgesState, addEdge, MarkerType,
    type Node, type Edge, type Connection, type NodeTypes, type EdgeTypes,
    Handle, Position, getBezierPath, BaseEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, AlertCircle, CheckCircle, Undo2, Redo2, LayoutGrid, Trash2, X, Plus, Lock } from 'lucide-react';
import { telephonyApi } from '../../services/telephonyApi';
import { NODE_KIND_META, type CallFlowNodeKind, type CallFlow, type CallFlowNode as CFNode, type CallFlowTransition } from '../../types/telephony';
import { layoutWithElkLayered } from '../../utils/elkLayout';
import { NodeKindInspector } from './nodeInspectors';
import { NODE_DEFAULTS, TERMINAL_KINDS, DISABLED_KINDS, LOCKED_KINDS, PALETTE_ORDER } from './nodeDefaults';

// ─── Types ────────────────────────────────────────────────────────────────────
type FlowNodeData = {
    label: string; kind: string; isInitial?: boolean; isProtected?: boolean;
    system?: boolean; immutable?: boolean; uiTerminal?: boolean; hidden?: boolean;
    labelExpr?: string; groupRef?: string; provider?: string; configRef?: string;
    config?: Record<string, unknown>;
};

// ── SCXML generator (blanc namespace) ────────────────────────────────────────
function graphToScxml(allNodes: Node<FlowNodeData>[], allEdges: Edge[]): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const initialNode = allNodes.find(n => n.data?.isInitial) || allNodes[0];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<scxml\n  xmlns="http://www.w3.org/2005/07/scxml"\n  xmlns:blanc="https://blanc.app/fsm"\n  version="1.0" datamodel="ecmascript"\n  initial="${esc(initialNode?.id || '')}"\n  blanc:machineType="call_flow"\n  blanc:schemaVersion="2"\n  blanc:skeleton="call_flow_skeleton_v2"\n>\n`;
    xml += `  <datamodel>\n    <data id="isBusinessHours" expr="false" />\n    <data id="currentGroupName" expr="'Current Group'" />\n  </datamodel>\n\n`;
    for (const node of allNodes) {
        const d = node.data;
        const kind = d?.kind || 'unknown';
        const outEdges = allEdges.filter(e => e.source === node.id);
        const isFinal = kind === 'final';
        const tag = isFinal ? 'final' : 'state';
        const ba: string[] = [];
        ba.push(`blanc:kind="${esc(kind)}"`);
        if (d?.labelExpr) ba.push(`blanc:labelExpr="${esc(d.labelExpr)}"`);
        else ba.push(`blanc:label="${esc(String(d?.label || ''))}"`);
        if (d?.groupRef) ba.push(`blanc:groupRef="${esc(d.groupRef)}"`);
        if (d?.system) ba.push(`blanc:system="true"`);
        if (d?.immutable) ba.push(`blanc:immutable="true"`);
        if (d?.isProtected) ba.push(`blanc:deletable="false"`);
        if (d?.uiTerminal) ba.push(`blanc:uiTerminal="true"`);
        if (d?.hidden) ba.push(`blanc:hidden="true"`);
        if (d?.config) ba.push(`blanc:configRef="${esc(JSON.stringify(d.config))}"`);
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
                if (ed.conditionType) ta.push(`blanc:conditionType="${esc(ed.conditionType)}"`);
                if (ed.conditionJson) ta.push(`blanc:conditionJson="${esc(JSON.stringify(ed.conditionJson))}"`);
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
            <Handle type="source" position={Position.Bottom} style={{ background: meta.color, width: 8, height: 8 }} />
        </div>
    );
}
const nodeTypes: NodeTypes = { flowNode: FlowNodeComponent };

// ─── Custom Edge with + button ────────────────────────────────────────────────
let _onEdgeInsert: ((edgeId: string, sourceX: number, sourceY: number, targetX: number, targetY: number) => void) | null = null;

function InsertableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, label, labelStyle }: any) {
    const [hovered, setHovered] = useState(false);
    const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
    return (
        <>
            <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
            {label && <text x={labelX} y={labelY - 10} textAnchor="middle" style={labelStyle}>{label}</text>}
            {/* Wide invisible interaction path for reliable hover */}
            <path d={edgePath} fill="none" stroke="transparent" strokeWidth={24}
                style={{ pointerEvents: 'stroke' }}
                onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} />
            {hovered && (
                <foreignObject x={labelX - 14} y={labelY - 14} width={28} height={28}
                    style={{ overflow: 'visible', pointerEvents: 'none' }}>
                    <div style={{ pointerEvents: 'auto' }}>
                        <button onClick={(e) => { e.stopPropagation(); _onEdgeInsert?.(id, sourceX, sourceY, targetX, targetY); }}
                            onMouseEnter={() => setHovered(true)}
                            style={{ width: 28, height: 28, borderRadius: '50%', border: '2px solid #6366f1', background: '#fff', color: '#6366f1', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.18)', fontSize: 0 }}>
                            <Plus size={16} />
                        </button>
                    </div>
                </foreignObject>
            )}
        </>
    );
}
const edgeTypes: EdgeTypes = { insertable: InsertableEdge };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function graphToReactFlow(states: CFNode[], transitions: CallFlowTransition[]) {
    // Filter out hidden nodes (finals) and hidden edges
    const visibleStates = (states || []).filter(s => !s.hidden);
    const visibleTransitions = (transitions || []).filter(t => !t.hidden);
    const nodes: Node<FlowNodeData>[] = visibleStates.map((s, i) => ({
        id: s.id, type: 'flowNode' as const, position: { x: 200, y: i * 120 },
        data: {
            label: s.name, kind: s.kind, isInitial: s.isInitial, isProtected: s.protected,
            system: s.system, immutable: s.immutable, uiTerminal: s.uiTerminal, hidden: s.hidden,
            labelExpr: s.labelExpr, groupRef: s.groupRef, config: s.config,
        },
    }));
    const edges: Edge[] = visibleTransitions.map(t => ({
        id: t.id, source: t.from_state_id, target: t.to_state_id,
        type: t.insertable ? 'insertable' : 'default',
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

/** Create React Flow nodes/edges for hidden elements (used in SCXML output only) */
function graphHiddenElements(states: CFNode[], transitions: CallFlowTransition[]) {
    const hiddenStates = states.filter(s => s.hidden);
    const hiddenTransitions = transitions.filter(t => t.hidden);
    const nodes: Node<FlowNodeData>[] = hiddenStates.map(s => ({
        id: s.id, type: 'flowNode' as const, position: { x: 0, y: 0 },
        data: {
            label: s.name, kind: s.kind, isInitial: s.isInitial, isProtected: s.protected,
            system: s.system, immutable: s.immutable, uiTerminal: s.uiTerminal, hidden: s.hidden,
            labelExpr: s.labelExpr, groupRef: s.groupRef, config: s.config,
        },
    }));
    const edges: Edge[] = hiddenTransitions.map(t => ({
        id: t.id, source: t.from_state_id, target: t.to_state_id, type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: {
            system: t.system, immutable: t.immutable, deletable: t.deletable, hidden: t.hidden,
            edgeRole: t.edgeRole, transitionMode: t.transitionMode, event_key: t.event_key,
            condExpr: t.condExpr
        },
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
    const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ type: 'node' | 'edge'; id: string; label: string } | null>(null);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const pendingLayoutRef = useRef(false);

    const { push: pushSnap, undo, redo, canUndo, canRedo } = useUndoRedo(nodes as any, edges, setNodes as any, setEdges as any);

    // Load flow (no versioning — single graph per flow)
    useEffect(() => {
        if (!flowId) return;
        (async () => {
            const f = await telephonyApi.getFlow(flowId);
            if (f) {
                setFlow(f);
                const graph = f.graph || { states: [], transitions: [] };
                const sts = graph.states || [];
                const trs = graph.transitions || [];
                const { nodes: n, edges: e } = graphToReactFlow(sts, trs);
                const hid = graphHiddenElements(sts, trs);
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
        setEdges(eds => addEdge({ ...p, type: 'insertable', markerEnd: { type: MarkerType.ArrowClosed }, label: 'transition', style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' } }, eds) as any);
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

    // ── Add node (palette — kept for insert picker reuse) ────────────────────
    // addNode is no longer used directly (palette removed), but insertNodeOnEdge references paletteKinds

    // ── Insert node on edge (edge + button) ──────────────────────────────────
    const [insertTarget, setInsertTarget] = useState<{ edgeId: string; midX: number; midY: number } | null>(null);

    const insertNodeOnEdge = useCallback((kind: CallFlowNodeKind) => {
        if (!insertTarget) return;
        pushSnap();
        const edge = (edges as any[]).find((e: any) => e.id === insertTarget.edgeId);
        if (!edge) { setInsertTarget(null); return; }
        const meta = NODE_KIND_META[kind];
        const id = `n-${Date.now()}`;

        if (kind === 'vapi_agent') {
            // ── Vapi Agent: create node with correct SCXML event transitions
            const newNode: Node<FlowNodeData> = {
                id, type: 'flowNode', position: { x: insertTarget.midX - 90, y: insertTarget.midY },
                data: {
                    label: 'AI Greeting', kind, provider: 'vapi', config: {
                        greeting_text: 'Thank you for calling. How can I help you today?',
                        first_message_mode: 'exact', locale: 'en-US',
                        strategy: 'dynamic_assistant_request', max_duration_seconds: 180, timeout_seconds: 45,
                        on_completed: 'continue_to_next_node', on_failed: 'fallback_transition',
                    }
                },
            };
            // Success edge: keep original target (continue flow)
            const eCompleted: Edge = { id: `e-${Date.now()}-ok`, source: id, target: edge.target, type: 'insertable', label: 'Continue', markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' }, data: { edgeRole: 'success', edgeLabel: 'Continue', transitionMode: 'event', event_key: 'vapi.completed' } };
            // Fallback edge: needs a target — point to edge's original target for now
            const eFallback: Edge = { id: `e-${Date.now()}-fb`, source: id, target: edge.target, type: 'insertable', label: 'Fallback', markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2, strokeDasharray: '4 3' }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#ef4444' }, data: { edgeRole: 'fallback', edgeLabel: 'Fallback', transitionMode: 'event', event_key: 'vapi.no_target vapi.failed vapi.timeout' } };
            // Incoming edge: from original source
            const eIn: Edge = { id: `e-${Date.now()}-in`, source: edge.source, target: id, type: 'insertable', label: edge.label, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' }, data: edge.data };
            setNodes(nds => [...nds, newNode] as any);
            setEdges(eds => [...(eds as any[]).filter((e: any) => e.id !== insertTarget.edgeId), eIn, eCompleted, eFallback] as any);
        } else {
            // ── Generic node insertion with kind-specific defaults
            const defaultConfig = NODE_DEFAULTS[kind] ? { ...NODE_DEFAULTS[kind] } : undefined;
            const isTerminal = TERMINAL_KINDS.has(kind);
            const newNode: Node<FlowNodeData> = {
                id, type: 'flowNode', position: { x: insertTarget.midX - 90, y: insertTarget.midY },
                data: { label: meta.label, kind, config: defaultConfig, uiTerminal: isTerminal || undefined },
            };
            const newEdge1: Edge = { id: `e-${Date.now()}-a`, source: edge.source, target: id, type: 'insertable', label: edge.label, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' } };
            if (isTerminal) {
                // Terminal nodes: only incoming edge, no outgoing
                setNodes(nds => [...nds, newNode] as any);
                setEdges(eds => [...(eds as any[]).filter((e: any) => e.id !== insertTarget.edgeId), newEdge1] as any);
            } else {
                const newEdge2: Edge = { id: `e-${Date.now()}-b`, source: id, target: edge.target, type: 'insertable', label: 'next', markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' } };
                setNodes(nds => [...nds, newNode] as any);
                setEdges(eds => [...(eds as any[]).filter((e: any) => e.id !== insertTarget.edgeId), newEdge1, newEdge2] as any);
            }
        }

        setInsertTarget(null);
        pendingLayoutRef.current = true;
    }, [insertTarget, edges, pushSnap, setNodes, setEdges]);

    // Wire global edge insert handler
    useEffect(() => {
        _onEdgeInsert = (edgeId, sourceX, sourceY, targetX, targetY) => {
            const midX = (sourceX + targetX) / 2;
            const midY = (sourceY + targetY) / 2;
            setInsertTarget({ edgeId, midX, midY });
        };
        return () => { _onEdgeInsert = null; };
    }, []);

    // ── Delete with edge healing ─────────────────────────────────────────────
    const confirmDelete = useCallback(() => {
        if (!showDeleteConfirm) return;
        pushSnap();
        if (showDeleteConfirm.type === 'node') {
            const id = showDeleteConfirm.id;
            const theNode = (nodes as any[]).find((n: any) => n.id === id);
            if (theNode?.data?.isProtected) { setShowDeleteConfirm(null); return; } // Guard
            // Edge healing: find incoming and outgoing edges, reconnect
            const incoming = (edges as any[]).filter((e: any) => e.target === id);
            const outgoing = (edges as any[]).filter((e: any) => e.source === id);
            const healEdges: Edge[] = [];
            for (const inc of incoming) {
                for (const out of outgoing) {
                    healEdges.push({ id: `heal-${Date.now()}-${Math.random()}`, source: inc.source, target: out.target, type: 'insertable', label: inc.label || 'reconnect', markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' } });
                }
            }
            setNodes(nds => (nds as any[]).filter((n: any) => n.id !== id) as any);
            setEdges(eds => [...(eds as any[]).filter((e: any) => e.source !== id && e.target !== id), ...healEdges] as any);
            setSelectedNode(null);
        } else {
            const id = showDeleteConfirm.id;
            // Guard: don't delete edges between two protected nodes
            const edge = (edges as any[]).find((e: any) => e.id === id);
            if (edge) {
                const src = (nodes as any[]).find((n: any) => n.id === edge.source);
                const tgt = (nodes as any[]).find((n: any) => n.id === edge.target);
                if (src?.data?.isProtected && tgt?.data?.isProtected) { setShowDeleteConfirm(null); return; }
            }
            setEdges(eds => (eds as any[]).filter((e: any) => e.id !== id) as any);
            setSelectedEdge(null);
        }
        setShowDeleteConfirm(null);
    }, [showDeleteConfirm, nodes, edges, setNodes, setEdges, pushSnap]);

    const runAutoLayout = useCallback(async () => {
        pushSnap();
        try { const laid = await layoutWithElkLayered(nodes as any, edges as any); setNodes(laid.nodes as any); setEdges(laid.edges as any); }
        catch { /* keep */ }
    }, [nodes, edges, setNodes, setEdges, pushSnap]);

    // Auto-layout after node insertion
    useEffect(() => {
        if (pendingLayoutRef.current) {
            pendingLayoutRef.current = false;
            runAutoLayout();
        }
    }, [nodes.length, runAutoLayout]);

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


    // Palette: ordered, with disabled/locked states
    const paletteKinds = PALETTE_ORDER.map(k => [k, NODE_KIND_META[k]] as [CallFlowNodeKind, (typeof NODE_KIND_META)['start']]);

    if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}><div style={{ width: 32, height: 32, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px)' }}>
            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><ArrowLeft size={14} />Back to Groups</button>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{flow?.name || 'Flow Builder'}</span>
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
                    <button onClick={() => setShowCancelConfirm(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', fontSize: 12, fontWeight: 500, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                </div>
            </div>

            {/* Main */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

                {/* Canvas */}
                <div style={{ flex: 1 }}>
                    <ReactFlow
                        nodes={nodes} edges={edges}
                        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                        onConnect={onConnect} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onPaneClick={onPaneClick}
                        nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.3 }} deleteKeyCode={null}
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
                            {selectedNode.data?.isProtected && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#fefce8', borderRadius: 6, marginBottom: 12, fontSize: 11, color: '#92400e', fontWeight: 500 }}>
                                    <Lock size={12} />System protected — cannot be deleted
                                </div>
                            )}
                            <div style={{ marginBottom: 12 }}>
                                <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Name</label>
                                {selectedNode.data?.isProtected
                                    ? <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>{selectedNode.data?.label}</div>
                                    : <input value={String(selectedNode.data?.label || '')} onChange={e => updateNodeName(selectedNode.id, e.target.value)} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                                }
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
                            {/* Kind-specific inspector for non-vapi nodes */}
                            {selectedNode.data?.kind !== 'vapi_agent' && selectedNode.data?.kind !== 'start' && selectedNode.data?.kind !== 'final' && (() => {
                                const cfg = (selectedNode.data?.config || {}) as Record<string, unknown>;
                                const updateCfg = (key: string, val: unknown) => {
                                    pushSnap();
                                    setNodes(nds => (nds as any[]).map((n: any) => n.id === selectedNode.id ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: val } } } : n) as any);
                                    setSelectedNode(p => p && p.id === selectedNode.id ? { ...p, data: { ...p.data, config: { ...p.data.config, [key]: val } } } : p);
                                };
                                return (
                                    <div style={{ marginBottom: 12 }}>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6, borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>Configuration</label>
                                        <NodeKindInspector kind={selectedNode.data?.kind as CallFlowNodeKind} cfg={cfg} updateCfg={updateCfg} isProtected={selectedNode.data?.isProtected} />
                                    </div>
                                );
                            })()}
                            {/* ── Vapi Agent Inspector ── */}
                            {selectedNode.data?.kind === 'vapi_agent' && (() => {
                                const cfg = (selectedNode.data?.config || {}) as Record<string, unknown>;
                                const updateCfg = (key: string, val: unknown) => {
                                    pushSnap();
                                    setNodes(nds => (nds as any[]).map((n: any) => n.id === selectedNode.id ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: val } } } : n) as any);
                                    setSelectedNode(p => p && p.id === selectedNode.id ? { ...p, data: { ...p.data, config: { ...p.data.config, [key]: val } } } : p);
                                };
                                const fieldStyle = { width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 } as const;
                                const sectionTitle = (title: string) => <div style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginTop: 14, marginBottom: 6, borderTop: '1px solid #ede9fe', paddingTop: 8 }}>{title}</div>;
                                return (<>
                                    {sectionTitle('Greeting')}
                                    <div style={{ marginBottom: 8 }}>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>First Message</label>
                                        <textarea value={String(cfg.greeting_text || '')} onChange={e => updateCfg('greeting_text', e.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical' }} />
                                    </div>
                                    <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                                        <div style={{ flex: 1 }}>
                                            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Mode</label>
                                            <select value={String(cfg.first_message_mode || 'exact')} onChange={e => updateCfg('first_message_mode', e.target.value)} style={fieldStyle}>
                                                <option value="exact">Exact text</option>
                                                <option value="prompt_template">Prompt template</option>
                                            </select>
                                        </div>
                                        <div style={{ flex: 1 }}>
                                            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Locale</label>
                                            <select value={String(cfg.locale || 'en-US')} onChange={e => updateCfg('locale', e.target.value)} style={fieldStyle}>
                                                <option value="en-US">English (US)</option>
                                                <option value="es-US">Spanish (US)</option>
                                            </select>
                                        </div>
                                    </div>

                                    {sectionTitle('Resolution')}
                                    <div style={{ marginBottom: 8 }}>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Strategy</label>
                                        <select value={String(cfg.strategy || 'dynamic_assistant_request')} onChange={e => updateCfg('strategy', e.target.value)} style={fieldStyle}>
                                            <option value="dynamic_assistant_request">Dynamic (assistant-request)</option>
                                            <option value="static_assistant">Static assistant</option>
                                        </select>
                                    </div>

                                    {sectionTitle('Call Behavior')}
                                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                                        <div style={{ flex: 1 }}>
                                            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Max Duration (s)</label>
                                            <input type="number" value={Number(cfg.max_duration_seconds || 180)} onChange={e => updateCfg('max_duration_seconds', parseInt(e.target.value))} style={fieldStyle} />
                                        </div>
                                        <div style={{ flex: 1 }}>
                                            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Timeout (s)</label>
                                            <input type="number" value={Number(cfg.timeout_seconds || 45)} onChange={e => updateCfg('timeout_seconds', parseInt(e.target.value))} style={fieldStyle} />
                                        </div>
                                    </div>

                                    {sectionTitle('Post-Agent Routing')}
                                    <div style={{ marginBottom: 8 }}>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>On Completed</label>
                                        <select value={String(cfg.on_completed || 'continue_to_next_node')} onChange={e => updateCfg('on_completed', e.target.value)} style={fieldStyle}>
                                            <option value="continue_to_next_node">Continue to next node</option>
                                            <option value="transfer_to_group_queue">Transfer to group queue</option>
                                            <option value="go_to_voicemail">Go to voicemail</option>
                                            <option value="end_flow">End flow</option>
                                        </select>
                                    </div>
                                    <div style={{ marginBottom: 8 }}>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>On Failed / Timeout</label>
                                        <select value={String(cfg.on_failed || 'fallback_transition')} onChange={e => updateCfg('on_failed', e.target.value)} style={fieldStyle}>
                                            <option value="fallback_transition">Fallback transition</option>
                                            <option value="transfer_to_group_queue">Transfer to group queue</option>
                                            <option value="go_to_voicemail">Go to voicemail</option>
                                            <option value="end_flow">End flow</option>
                                        </select>
                                    </div>

                                    {sectionTitle('Context')}
                                    {(['include_group_name', 'include_called_number', 'include_caller_number', 'include_transfer_targets'] as const).map(key => (
                                        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#374151', marginBottom: 4, cursor: 'pointer' }}>
                                            <input type="checkbox" checked={cfg[key] !== false} onChange={e => updateCfg(key, e.target.checked)} style={{ accentColor: '#7c3aed' }} />
                                            {key.replace('include_', '').replace(/_/g, ' ')}
                                        </label>
                                    ))}
                                </>);
                            })()}
                            {/* Only show delete for non-protected, non-start nodes */}
                            {!selectedNode.data?.isProtected && (
                                <button onClick={() => setShowDeleteConfirm({ type: 'node', id: selectedNode.id, label: String(selectedNode.data?.label || selectedNode.id) })}
                                    style={{ marginTop: 12, width: '100%', padding: 8, fontSize: 12, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                    <Trash2 size={13} />Delete Node
                                </button>
                            )}
                        </div>
                    )}
                    {selectedEdge && (() => {
                        const srcNode = (nodes as any[]).find((n: any) => n.id === selectedEdge.source);
                        const tgtNode = (nodes as any[]).find((n: any) => n.id === selectedEdge.target);
                        const isSystemEdge = !!(srcNode?.data?.isProtected && tgtNode?.data?.isProtected);
                        return (
                            <div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Edge Inspector</div>
                                {isSystemEdge && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#fefce8', borderRadius: 6, marginBottom: 12, fontSize: 11, color: '#92400e', fontWeight: 500 }}>
                                        <Lock size={12} />System edge — cannot be deleted
                                    </div>
                                )}
                                <div style={{ marginBottom: 12 }}>
                                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>From → To</label>
                                    <div style={{ fontSize: 12 }}><span style={{ fontWeight: 500 }}>{getNodeLabel(selectedEdge.source)}</span><span style={{ color: '#9ca3af' }}> → </span><span style={{ fontWeight: 500 }}>{getNodeLabel(selectedEdge.target)}</span></div>
                                </div>
                                <div style={{ marginBottom: 12 }}>
                                    <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>Label / Event Key</label>
                                    {isSystemEdge
                                        ? <div style={{ fontSize: 13, fontWeight: 500, color: '#374151', padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>{selectedEdge.label || '—'}</div>
                                        : <input value={String(selectedEdge.label || '')} onChange={e => updateEdgeLabel(selectedEdge.id, e.target.value)} style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                                    }
                                </div>
                                {!isSystemEdge && (
                                    <button onClick={() => setShowDeleteConfirm({ type: 'edge', id: selectedEdge.id, label: `${getNodeLabel(selectedEdge.source)} → ${getNodeLabel(selectedEdge.target)}` })}
                                        style={{ marginTop: 12, width: '100%', padding: 8, fontSize: 12, fontWeight: 500, background: '#fef2f2', color: '#ef4444', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                        <Trash2 size={13} />Delete Edge
                                    </button>
                                )}
                            </div>
                        );
                    })()}
                </div>
            </div>

            {/* Delete Confirm */}
            {
                showDeleteConfirm && (
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
                )
            }


            {/* Insert Node Picker (appears when + clicked on edge) */}
            {
                insertTarget && (
                    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setInsertTarget(null)}>
                        <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 20, maxWidth: 360, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Insert Node</h3>
                                <button onClick={() => setInsertTarget(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 0 }}><X size={16} /></button>
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>Choose a node type to insert into this branch:</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                {paletteKinds.map(([kind, meta]) => {
                                    const isDisabled = DISABLED_KINDS.has(kind);
                                    const isLocked = LOCKED_KINDS.has(kind);
                                    return (
                                        <button key={kind} onClick={() => !isDisabled && !isLocked && insertNodeOnEdge(kind)}
                                            title={isDisabled ? 'Planned later; not in current scope' : isLocked ? 'Managed separately' : meta.label}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', fontSize: 12, fontWeight: 500,
                                                background: isDisabled || isLocked ? '#f3f4f6' : '#f9fafb',
                                                border: `1px solid ${isDisabled || isLocked ? '#e5e7eb' : '#d1d5db'}`,
                                                borderRadius: 6, cursor: isDisabled || isLocked ? 'not-allowed' : 'pointer',
                                                color: isDisabled || isLocked ? '#9ca3af' : '#374151', textAlign: 'left',
                                                opacity: isDisabled || isLocked ? 0.5 : 1,
                                            }}>
                                            <span style={{ fontSize: 14 }}>{meta.icon}</span>
                                            <span>{meta.label}</span>
                                            {isLocked && <span style={{ fontSize: 9, marginLeft: 'auto', color: '#9ca3af' }}>🔒</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Cancel Confirm */}
            {
                showCancelConfirm && (
                    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowCancelConfirm(false)}>
                        <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 24, maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Discard changes?</h3>
                                <button onClick={() => setShowCancelConfirm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 0 }}><X size={18} /></button>
                            </div>
                            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>Any unsaved changes to this flow will be lost.</p>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                <button onClick={() => setShowCancelConfirm(false)} style={{ padding: '8px 16px', fontSize: 13, background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Keep Editing</button>
                                <button onClick={() => navigate('/settings/telephony/user-groups')} style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Discard & Close</button>
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    );
}

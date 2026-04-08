/**
 * Full-screen visual FSM Workflow Builder.
 * Modeled after CallFlowBuilderPage — uses @xyflow/react + elkjs.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    addEdge,
    MarkerType,
    type Node,
    type Edge,
    type Connection,
    type NodeTypes,
    type EdgeTypes,
    type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
    ArrowLeft,
    Save,
    Undo2,
    Redo2,
    LayoutGrid,
    CheckCircle,
    AlertCircle,
    Plus,
    ShieldCheck,
    Download,
    X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    useFsmDraft,
    useFsmActiveVersion,
    useSaveDraft,
    useValidateScxml,
    usePublishDraft,
    type ValidationResult,
} from '../../hooks/useFsmEditor';
import { useAuthz } from '../../hooks/useAuthz';
import { layoutWithElkLayered } from '../../utils/workflowElkLayout';
import {
    scxmlToGraph,
    graphToScxml,
    type WorkflowNodeData,
    type WorkflowEdgeData,
} from './workflowScxmlCodec';
import {
    WorkflowStateNode,
    WorkflowFinalNode,
    WorkflowInsertableEdge,
    setOnEdgeInsert,
} from './workflowNodeTypes';
import {
    FlowPropertiesPanel,
    StateInspector,
    TransitionInspector,
} from './workflowInspectors';

// ─── Node / Edge type registries ─────────────────────────────────────────────

const nodeTypes: NodeTypes = {
    workflowState: WorkflowStateNode as any,
    workflowFinal: WorkflowFinalNode as any,
};

const edgeTypes: EdgeTypes = {
    workflowInsertable: WorkflowInsertableEdge as any,
};

// ─── Undo / Redo ─────────────────────────────────────────────────────────────

interface Snapshot {
    nodes: Node<WorkflowNodeData>[];
    edges: Edge[];
}

function useUndoRedo(
    nodes: Node<WorkflowNodeData>[],
    edges: Edge[],
    setNodes: (n: Node<WorkflowNodeData>[] | ((p: Node<WorkflowNodeData>[]) => Node<WorkflowNodeData>[])) => void,
    setEdges: (e: Edge[] | ((p: Edge[]) => Edge[])) => void,
) {
    const undoStack = useRef<Snapshot[]>([]);
    const redoStack = useRef<Snapshot[]>([]);
    const last = useRef('');

    const push = useCallback(() => {
        const k = JSON.stringify({ n: nodes.map((n) => n.id), e: edges.map((e) => e.id) });
        if (k === last.current) return;
        last.current = k;
        undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
        redoStack.current = [];
    }, [nodes, edges]);

    const undo = useCallback(() => {
        const s = undoStack.current.pop();
        if (!s) return;
        redoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
        setNodes(s.nodes as any);
        setEdges(s.edges as any);
        last.current = JSON.stringify({ n: s.nodes.map((n) => n.id), e: s.edges.map((e) => e.id) });
    }, [nodes, edges, setNodes, setEdges]);

    const redo = useCallback(() => {
        const s = redoStack.current.pop();
        if (!s) return;
        undoStack.current.push({ nodes: structuredClone(nodes), edges: structuredClone(edges) });
        setNodes(s.nodes as any);
        setEdges(s.edges as any);
        last.current = JSON.stringify({ n: s.nodes.map((n) => n.id), e: s.edges.map((e) => e.id) });
    }, [nodes, edges, setNodes, setEdges]);

    return {
        push,
        undo,
        redo,
        canUndo: undoStack.current.length > 0,
        canRedo: redoStack.current.length > 0,
    };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function WorkflowBuilderPage() {
    const { machineKey } = useParams<{ machineKey: string }>();
    const navigate = useNavigate();

    // ── Data hooks ────────────────────────────────────────────────────────
    const { data: draft, isLoading: draftLoading } = useFsmDraft(machineKey || null);
    const { data: active, isLoading: activeLoading } = useFsmActiveVersion(machineKey || null);
    const saveDraft = useSaveDraft(machineKey || '');
    const validateScxml = useValidateScxml(machineKey || '');
    const publishDraft = usePublishDraft(machineKey || '');
    const { hasPermission } = useAuthz();
    // canPublish check removed — Save auto-publishes

    // ── Graph state ───────────────────────────────────────────────────────
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNodeData>>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [initialStateId, setInitialStateId] = useState('');
    const [machineTitle, setMachineTitle] = useState('');
    const [dirty, setDirty] = useState(false);
    const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
    const [selectedNode, setSelectedNode] = useState<Node<WorkflowNodeData> | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
    const [showAddState, setShowAddState] = useState(false);
    const [newStateName, setNewStateName] = useState('');
    const [newStateIsFinal, setNewStateIsFinal] = useState(false);
    const [insertEdgeId, setInsertEdgeId] = useState<string | null>(null);

    const initialised = useRef(false);
    const pendingLayoutRef = useRef(false);
    const reactFlowRef = useRef<ReactFlowInstance | null>(null);

    const { push: pushSnap, undo, redo, canUndo, canRedo } = useUndoRedo(nodes, edges, setNodes, setEdges);

    // ── Initialize from SCXML ─────────────────────────────────────────────
    useEffect(() => {
        if (initialised.current) return;
        if (draftLoading || activeLoading) return;

        let scxmlSource = '';
        if (draft?.scxml_source) scxmlSource = draft.scxml_source;
        else if (active?.scxml_source) scxmlSource = active.scxml_source;

        if (!scxmlSource) {
            initialised.current = true;
            return;
        }

        try {
            const graph = scxmlToGraph(scxmlSource);
            setInitialStateId(graph.initialStateId);
            setMachineTitle(graph.machineTitle);

            // Auto-layout
            layoutWithElkLayered(graph.nodes, graph.edges).then(({ nodes: laid, edges: laidEdges }) => {
                setNodes(laid as any);
                setEdges(laidEdges as any);
                // fitView after initial layout (small delay for React to render)
                setTimeout(() => reactFlowRef.current?.fitView({ padding: 0.2 }), 100);
            });
        } catch (err) {
            toast.error('Failed to parse SCXML: ' + (err instanceof Error ? err.message : String(err)));
        }

        initialised.current = true;
    }, [draft, active, draftLoading, activeLoading, setNodes, setEdges]);

    // ── Edge insert callback ──────────────────────────────────────────────
    useEffect(() => {
        setOnEdgeInsert((edgeId: string) => {
            setInsertEdgeId(edgeId);
            setShowAddState(true);
            setNewStateName('');
            setNewStateIsFinal(false);
        });
        return () => setOnEdgeInsert(null);
    }, []);

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
                e.preventDefault();
                redo();
            } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                handleSave();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges, dirty, undo, redo]);

    // ── Beforeunload guard ────────────────────────────────────────────────
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (dirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [dirty]);

    // ── Auto-layout after insert ──────────────────────────────────────────
    useEffect(() => {
        if (!pendingLayoutRef.current || nodes.length === 0) return;
        pendingLayoutRef.current = false;
        layoutWithElkLayered(nodes, edges).then(({ nodes: laid, edges: laidEdges }) => {
            setNodes(laid as any);
            setEdges(laidEdges as any);
            setTimeout(() => reactFlowRef.current?.fitView({ padding: 0.2 }), 100);
        });
    }, [nodes, edges, setNodes, setEdges]);

    // ── Keep selectedNode/Edge in sync with current state ─────────────────
    const currentSelectedNode = useMemo(
        () => (selectedNode ? nodes.find((n) => n.id === selectedNode.id) || null : null),
        [selectedNode, nodes],
    );
    const currentSelectedEdge = useMemo(
        () => (selectedEdge ? edges.find((e) => e.id === selectedEdge.id) || null : null),
        [selectedEdge, edges],
    );

    // ── Graph interaction handlers ────────────────────────────────────────

    const onConnect = useCallback(
        (params: Connection) => {
            pushSnap();
            const newEdge: Edge = {
                id: `${params.source}--new--${params.target}`,
                source: params.source!,
                target: params.target!,
                type: 'workflowInsertable',
                markerEnd: { type: MarkerType.ArrowClosed },
                style: { strokeWidth: 2 },
                labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' },
                data: {
                    event: `TO_${(params.target || '').toUpperCase()}`,
                    isAction: true,
                    label: 'New Transition',
                    icon: '',
                    confirm: false,
                    confirmText: '',
                    order: null,
                    roles: '',
                    hotkey: '',
                } as WorkflowEdgeData,
                label: 'New Transition',
            };
            setEdges((eds) => addEdge(newEdge, eds));
            setSelectedEdge(newEdge);
            setSelectedNode(null);
            setDirty(true);
        },
        [pushSnap, setEdges],
    );

    const onNodeClick = useCallback(
        (_: React.MouseEvent, node: Node) => {
            setSelectedNode(node as Node<WorkflowNodeData>);
            setSelectedEdge(null);
        },
        [],
    );

    const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
        setSelectedEdge(edge);
        setSelectedNode(null);
    }, []);

    const onPaneClick = useCallback(() => {
        setSelectedNode(null);
        setSelectedEdge(null);
    }, []);

    // ── Node/Edge update handlers ─────────────────────────────────────────

    const handleUpdateNode = useCallback(
        (id: string, data: Partial<WorkflowNodeData>) => {
            pushSnap();
            setNodes((nds) =>
                nds.map((n) =>
                    n.id === id ? { ...n, data: { ...n.data, ...data } as WorkflowNodeData } : n,
                ),
            );
            setDirty(true);
        },
        [pushSnap, setNodes],
    );

    const handleUpdateEdge = useCallback(
        (id: string, data: Partial<WorkflowEdgeData>) => {
            pushSnap();
            setEdges((eds) =>
                eds.map((e) => {
                    if (e.id !== id) return e;
                    const newData = { ...(e.data || {}), ...data } as WorkflowEdgeData;
                    return { ...e, data: newData, label: newData.label || e.label };
                }),
            );
            setDirty(true);
        },
        [pushSnap, setEdges],
    );

    const handleSetInitial = useCallback(
        (id: string) => {
            pushSnap();
            setNodes((nds) =>
                nds.map((n) => ({
                    ...n,
                    data: { ...n.data, isInitial: n.id === id } as WorkflowNodeData,
                })),
            );
            setInitialStateId(id);
            setDirty(true);
        },
        [pushSnap, setNodes],
    );

    const handleDeleteNode = useCallback(
        (id: string) => {
            pushSnap();
            // Edge healing: connect all incoming sources to all outgoing targets
            const incoming = edges.filter((e) => e.target === id);
            const outgoing = edges.filter((e) => e.source === id);
            const healedEdges: Edge[] = [];
            for (const inc of incoming) {
                for (const out of outgoing) {
                    healedEdges.push({
                        ...out,
                        id: `${inc.source}--healed--${out.target}`,
                        source: inc.source,
                    });
                }
            }
            setEdges((eds) => [
                ...eds.filter((e) => e.source !== id && e.target !== id),
                ...healedEdges,
            ]);
            setNodes((nds) => nds.filter((n) => n.id !== id));
            setSelectedNode(null);
            setDirty(true);
        },
        [pushSnap, edges, setEdges, setNodes],
    );

    const handleDeleteEdge = useCallback(
        (id: string) => {
            pushSnap();
            setEdges((eds) => eds.filter((e) => e.id !== id));
            setSelectedEdge(null);
            setDirty(true);
        },
        [pushSnap, setEdges],
    );

    // ── Add State ─────────────────────────────────────────────────────────

    const handleAddState = useCallback(() => {
        const name = newStateName.trim();
        if (!name) {
            toast.warning('State name is required');
            return;
        }

        pushSnap();

        const stateId = name.replace(/\s+/g, '_');
        const newNode: Node<WorkflowNodeData> = {
            id: stateId,
            type: newStateIsFinal ? 'workflowFinal' : 'workflowState',
            position: { x: 300, y: 300 },
            data: {
                label: name,
                statusName: name,
                stateId,
                isFinal: newStateIsFinal,
                isInitial: false,
            },
        };

        if (insertEdgeId) {
            // Splice into edge
            const edge = edges.find((e) => e.id === insertEdgeId);
            if (edge) {
                const inEdge: Edge = {
                    id: `${edge.source}--to--${stateId}`,
                    source: edge.source,
                    target: stateId,
                    type: 'workflowInsertable',
                    markerEnd: { type: MarkerType.ArrowClosed },
                    style: { strokeWidth: 2 },
                    labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' },
                    data: { ...((edge.data || {}) as WorkflowEdgeData) },
                    label: (edge.data as any)?.label || edge.label,
                };

                if (!newStateIsFinal) {
                    const outEdge: Edge = {
                        id: `${stateId}--to--${edge.target}`,
                        source: stateId,
                        target: edge.target,
                        type: 'workflowInsertable',
                        markerEnd: { type: MarkerType.ArrowClosed },
                        style: { strokeWidth: 2 },
                        labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' },
                        data: {
                            event: `TO_${edge.target.toUpperCase()}`,
                            isAction: true,
                            label: `To ${edge.target.replace(/_/g, ' ')}`,
                            icon: '',
                            confirm: false,
                            confirmText: '',
                            order: null,
                            roles: '',
                            hotkey: '',
                        } as WorkflowEdgeData,
                        label: `To ${edge.target.replace(/_/g, ' ')}`,
                    };
                    setEdges((eds) => [...eds.filter((e) => e.id !== insertEdgeId), inEdge, outEdge]);
                } else {
                    setEdges((eds) => [...eds.filter((e) => e.id !== insertEdgeId), inEdge]);
                }
            }
        }

        setNodes((nds) => [...nds, newNode]);
        setShowAddState(false);
        setInsertEdgeId(null);
        setNewStateName('');
        setNewStateIsFinal(false);
        setDirty(true);
        pendingLayoutRef.current = true;
    }, [newStateName, newStateIsFinal, insertEdgeId, edges, pushSnap, setNodes, setEdges]);

    // ── Actions ───────────────────────────────────────────────────────────

    const handleAutoLayout = useCallback(async () => {
        pushSnap();
        const result = await layoutWithElkLayered(nodes, edges);
        setNodes(result.nodes as any);
        setEdges(result.edges as any);
        setTimeout(() => reactFlowRef.current?.fitView({ padding: 0.2 }), 100);
    }, [pushSnap, nodes, edges, setNodes, setEdges]);

    const handleSave = useCallback(async () => {
        if (!dirty || saveDraft.isPending || publishDraft.isPending) return;
        try {
            const scxml = graphToScxml(nodes, edges, initialStateId, machineKey, machineTitle);
            await saveDraft.mutateAsync({ scxml_source: scxml });
            setDirty(false);

            // Auto-publish after save
            await publishDraft.mutateAsync({ change_note: 'Auto-publish on save' });
            toast.success('Saved & published');
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : 'Failed to save');
        }
    }, [dirty, saveDraft, publishDraft, nodes, edges, initialStateId, machineKey, machineTitle]);

    const handleValidate = useCallback(async () => {
        try {
            const scxml = graphToScxml(nodes, edges, initialStateId, machineKey, machineTitle);
            const result = await validateScxml.mutateAsync({ scxml_source: scxml });
            setValidationResult(result);
            if (result.valid) {
                toast.success('SCXML is valid');
            } else {
                toast.error(`Validation failed — ${result.errors.length} error(s)`);
            }
        } catch {
            toast.error('Network error during validation');
        }
    }, [validateScxml, nodes, edges, initialStateId, machineKey, machineTitle]);

    const handleExport = useCallback(() => {
        const scxml = graphToScxml(nodes, edges, initialStateId, machineKey, machineTitle);
        const blob = new Blob([scxml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${machineKey}-workflow.scxml`;
        a.click();
        URL.revokeObjectURL(url);
    }, [nodes, edges, initialStateId, machineKey, machineTitle]);

    const handleBack = useCallback(() => {
        if (dirty) {
            if (!window.confirm('You have unsaved changes. Discard and leave?')) return;
        }
        navigate('/settings/lead-form');
    }, [dirty, navigate]);

    // ── Status badge ──────────────────────────────────────────────────────

    const statusBadge = useMemo(() => {
        if (validationResult && !validationResult.valid) {
            return (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                    <AlertCircle className="w-3 h-3" /> Errors
                </span>
            );
        }
        if (dirty) {
            return (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                    <AlertCircle className="w-3 h-3" /> Unsaved
                </span>
            );
        }
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                <CheckCircle className="w-3 h-3" /> Saved
            </span>
        );
    }, [validationResult, dirty]);

    // ── Loading ───────────────────────────────────────────────────────────

    if (draftLoading || activeLoading) {
        return (
            <div className="flex items-center justify-center h-screen text-[var(--blanc-ink-3)]">
                Loading workflow...
            </div>
        );
    }

    // ── Render ────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-screen bg-[var(--blanc-bg)]">
            {/* ── Toolbar ──────────────────────────────────────────────── */}
            <div className="h-14 border-b border-[var(--blanc-line)] flex items-center px-4 gap-3 shrink-0">
                {/* Left: back + title */}
                <button
                    onClick={handleBack}
                    className="inline-flex items-center gap-1.5 text-sm text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)] transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    <span className="font-[var(--blanc-font-heading)] font-semibold">
                        {machineTitle || machineKey}
                    </span>
                </button>

                <div className="mx-2 h-5 w-px bg-[var(--blanc-line)]" />

                {statusBadge}

                <div className="flex-1" />

                {/* Center: undo/redo + layout */}
                <button
                    onClick={undo}
                    disabled={!canUndo}
                    className="inline-flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors disabled:opacity-30"
                    title="Undo (Ctrl+Z)"
                >
                    <Undo2 className="w-3.5 h-3.5" />
                </button>
                <button
                    onClick={redo}
                    disabled={!canRedo}
                    className="inline-flex items-center gap-1 px-2 py-1.5 text-xs rounded-lg bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors disabled:opacity-30"
                    title="Redo (Ctrl+Y)"
                >
                    <Redo2 className="w-3.5 h-3.5" />
                </button>

                <div className="mx-1 h-5 w-px bg-[var(--blanc-line)]" />

                <button
                    onClick={handleAutoLayout}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors"
                >
                    <LayoutGrid className="w-3.5 h-3.5" /> Layout
                </button>

                <button
                    onClick={() => {
                        setInsertEdgeId(null);
                        setShowAddState(true);
                        setNewStateName('');
                        setNewStateIsFinal(false);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" /> Add State
                </button>

                <div className="mx-1 h-5 w-px bg-[var(--blanc-line)]" />

                {/* Right: actions */}
                <button
                    onClick={handleValidate}
                    disabled={validateScxml.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors disabled:opacity-50"
                >
                    <ShieldCheck className="w-3.5 h-3.5" /> Validate
                </button>

                <button
                    onClick={handleSave}
                    disabled={!dirty || saveDraft.isPending || publishDraft.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                    <Save className="w-3.5 h-3.5" /> {saveDraft.isPending || publishDraft.isPending ? 'Saving...' : 'Save'}
                </button>

                <button
                    onClick={handleExport}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors"
                >
                    <Download className="w-3.5 h-3.5" /> Export
                </button>
            </div>

            {/* ── Canvas + Inspector ───────────────────────────────────── */}
            <div className="flex flex-1 overflow-hidden">
                {/* Canvas */}
                <div className="flex-1 min-w-0">
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeClick={onNodeClick}
                        onEdgeClick={onEdgeClick}
                        onPaneClick={onPaneClick}
                        onInit={(instance) => { reactFlowRef.current = instance; }}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.2 }}
                        defaultEdgeOptions={{
                            type: 'workflowInsertable',
                            markerEnd: { type: MarkerType.ArrowClosed },
                            style: { strokeWidth: 2 },
                        }}
                    >
                        <Background gap={20} size={1} color="rgba(117,106,89,0.08)" />
                        <Controls />
                        <MiniMap
                            nodeStrokeWidth={3}
                            style={{ background: 'rgba(117,106,89,0.04)' }}
                        />
                    </ReactFlow>
                </div>

                {/* Inspector Sidebar */}
                <div
                    className="w-[300px] border-l border-[var(--blanc-line)] overflow-y-auto shrink-0"
                    style={{ padding: 16 }}
                >
                    {currentSelectedNode ? (
                        <StateInspector
                            node={currentSelectedNode}
                            edges={edges}
                            nodes={nodes}
                            onUpdateNode={handleUpdateNode}
                            onDeleteNode={handleDeleteNode}
                            onSetInitial={handleSetInitial}
                        />
                    ) : currentSelectedEdge ? (
                        <TransitionInspector
                            edge={currentSelectedEdge}
                            nodes={nodes}
                            onUpdateEdge={handleUpdateEdge}
                            onDeleteEdge={handleDeleteEdge}
                        />
                    ) : (
                        <FlowPropertiesPanel
                            nodes={nodes}
                            edges={edges}
                            initialStateId={initialStateId}
                            machineTitle={machineTitle}
                            machineKey={machineKey || ''}
                            validationErrors={validationResult?.errors.map((e) => e.message)}
                            validationWarnings={validationResult?.warnings.map((w) => w.message)}
                        />
                    )}
                </div>
            </div>

            {/* ── Add State Dialog ─────────────────────────────────────── */}
            {showAddState && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.3)' }}
                    onClick={() => setShowAddState(false)}
                >
                    <div
                        className="bg-white rounded-2xl shadow-xl w-[360px]"
                        style={{ padding: 24 }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-base font-semibold text-[var(--blanc-ink-1)]">
                                {insertEdgeId ? 'Insert State' : 'Add State'}
                            </h3>
                            <button
                                onClick={() => {
                                    setShowAddState(false);
                                    setInsertEdgeId(null);
                                }}
                                className="text-[var(--blanc-ink-3)] hover:text-[var(--blanc-ink-1)]"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex flex-col gap-4">
                            <div>
                                <label
                                    className="text-xs text-[var(--blanc-ink-3)] block mb-1"
                                >
                                    State Name
                                </label>
                                <input
                                    type="text"
                                    value={newStateName}
                                    onChange={(e) => setNewStateName(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddState()}
                                    placeholder="e.g. Waiting for Parts"
                                    autoFocus
                                    className="w-full text-sm px-3 py-2 rounded-lg border border-[var(--blanc-line)] outline-none focus:border-[rgba(117,106,89,0.4)]"
                                />
                                <div className="text-xs text-[var(--blanc-ink-3)] mt-1">
                                    ID: {newStateName.trim().replace(/\s+/g, '_') || '...'}
                                </div>
                            </div>

                            <label className="flex items-center gap-2 text-sm text-[var(--blanc-ink-2)]">
                                <input
                                    type="checkbox"
                                    checked={newStateIsFinal}
                                    onChange={(e) => setNewStateIsFinal(e.target.checked)}
                                    style={{ accentColor: '#6366f1' }}
                                />
                                Final state (no outgoing transitions)
                            </label>

                            <div className="flex justify-end gap-2 mt-2">
                                <button
                                    onClick={() => {
                                        setShowAddState(false);
                                        setInsertEdgeId(null);
                                    }}
                                    className="px-4 py-2 text-sm rounded-lg border border-[var(--blanc-line)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.06)]"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleAddState}
                                    className="px-4 py-2 text-sm rounded-lg bg-[var(--blanc-ink-1)] text-white hover:opacity-90"
                                >
                                    {insertEdgeId ? 'Insert' : 'Add'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

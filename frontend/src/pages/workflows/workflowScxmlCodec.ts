/**
 * Bidirectional SCXML ↔ ReactFlow graph codec for FSM Workflow Builder.
 *
 * scxmlToGraph — parse SCXML string → { nodes, edges, initialStateId, machineTitle }
 * graphToScxml — convert ReactFlow nodes + edges → SCXML string
 */

import type { Node, Edge } from '@xyflow/react';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowNodeData {
    label: string;
    statusName: string;
    stateId: string;
    isFinal: boolean;
    isInitial: boolean;
    [key: string]: unknown;
}

export interface WorkflowEdgeData {
    event: string;
    isAction: boolean;
    label: string;
    icon: string;
    confirm: boolean;
    confirmText: string;
    order: number | null;
    roles: string;
    hotkey: string;
    [key: string]: unknown;
}

export interface ScxmlGraph {
    nodes: Node<WorkflowNodeData>[];
    edges: Edge[];
    initialStateId: string;
    machineTitle: string;
}

const BLANC_NS = 'https://blanc.app/fsm';

// ─── Parse SCXML → Graph ────────────────────────────────────────────────────

export function scxmlToGraph(scxmlString: string): ScxmlGraph {
    const parser = new DOMParser();
    const doc = parser.parseFromString(scxmlString, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        throw new Error(`XML parse error: ${parseError.textContent?.slice(0, 200)}`);
    }

    const scxml = doc.documentElement;
    if (scxml.tagName !== 'scxml') throw new Error('Root element must be <scxml>');

    const initialStateId = scxml.getAttribute('initial') || '';
    const machineTitle =
        scxml.getAttributeNS(BLANC_NS, 'title') ||
        scxml.getAttributeNS(BLANC_NS, 'machine') ||
        '';

    const nodes: Node<WorkflowNodeData>[] = [];
    const edges: Edge[] = [];

    const stateElements = scxml.querySelectorAll(':scope > state, :scope > final');

    stateElements.forEach((el, index) => {
        const id = el.getAttribute('id') || `state_${index}`;
        const isFinal = el.tagName === 'final';
        const label =
            el.getAttributeNS(BLANC_NS, 'label') ||
            el.getAttributeNS(BLANC_NS, 'statusName') ||
            id.replace(/_/g, ' ');
        const statusName =
            el.getAttributeNS(BLANC_NS, 'statusName') ||
            el.getAttributeNS(BLANC_NS, 'label') ||
            id.replace(/_/g, ' ');
        const isInitial = id === initialStateId;

        nodes.push({
            id,
            type: isFinal ? 'workflowFinal' : 'workflowState',
            position: { x: 200, y: index * 120 },
            data: { label, statusName, stateId: id, isFinal, isInitial },
        });

        // Parse transitions
        const transitions = el.querySelectorAll(':scope > transition');
        transitions.forEach((tr) => {
            const event = tr.getAttribute('event') || '';
            const target = tr.getAttribute('target') || '';
            if (!target) return;

            const edgeLabel = tr.getAttributeNS(BLANC_NS, 'label') || event;
            const isAction = tr.getAttributeNS(BLANC_NS, 'action') === 'true';
            const icon = tr.getAttributeNS(BLANC_NS, 'icon') || '';
            const confirm = tr.getAttributeNS(BLANC_NS, 'confirm') === 'true';
            const confirmText = tr.getAttributeNS(BLANC_NS, 'confirmText') || '';
            const orderAttr = tr.getAttributeNS(BLANC_NS, 'order');
            const order = orderAttr ? Number(orderAttr) : null;
            const roles = tr.getAttributeNS(BLANC_NS, 'roles') || '';
            const hotkey = tr.getAttributeNS(BLANC_NS, 'hotkey') || '';

            edges.push({
                id: `${id}--${event}--${target}`,
                source: id,
                target,
                type: 'workflowInsertable',
                label: edgeLabel,
                markerEnd: { type: 'arrowclosed' as any },
                style: { strokeWidth: 2 },
                labelStyle: { fontSize: 10, fontWeight: 500, fill: '#6b7280' },
                data: { event, isAction, label: edgeLabel, icon, confirm, confirmText, order, roles, hotkey },
            });
        });
    });

    return { nodes, edges, initialStateId, machineTitle };
}

// ─── Graph → SCXML ──────────────────────────────────────────────────────────

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function graphToScxml(
    nodes: Node<WorkflowNodeData>[],
    edges: Edge[],
    initialStateId: string,
    machineKey?: string,
    machineTitle?: string,
): string {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<scxml xmlns="http://www.w3.org/2005/07/scxml"\n`;
    xml += `       xmlns:blanc="https://blanc.app/fsm"\n`;
    xml += `       version="1.0"\n`;
    xml += `       initial="${esc(initialStateId)}"`;
    if (machineKey) xml += `\n       blanc:machine="${esc(machineKey)}"`;
    if (machineTitle) xml += `\n       blanc:title="${esc(machineTitle)}"`;
    xml += `>\n\n`;

    for (const node of nodes) {
        const d = node.data as WorkflowNodeData;
        const tag = d.isFinal ? 'final' : 'state';
        const outEdges = edges
            .filter(e => e.source === node.id)
            .sort((a, b) => {
                const oa = (a.data as any)?.order ?? Infinity;
                const ob = (b.data as any)?.order ?? Infinity;
                return oa - ob;
            });

        const attrs: string[] = [`id="${esc(d.stateId)}"`];
        attrs.push(`blanc:label="${esc(d.label)}"`);
        if (d.statusName && d.statusName !== d.label) {
            attrs.push(`blanc:statusName="${esc(d.statusName)}"`);
        }

        if (outEdges.length === 0) {
            xml += `  <${tag} ${attrs.join(' ')} />\n\n`;
        } else {
            xml += `  <${tag} ${attrs.join(' ')}>\n`;
            for (const edge of outEdges) {
                const ed = (edge.data || {}) as WorkflowEdgeData;
                const ta: string[] = [];
                if (ed.event) ta.push(`event="${esc(ed.event)}"`);
                ta.push(`target="${esc(edge.target)}"`);
                if (ed.isAction) ta.push(`blanc:action="true"`);
                if (ed.label) ta.push(`blanc:label="${esc(ed.label)}"`);
                if (ed.order != null) ta.push(`blanc:order="${ed.order}"`);
                if (ed.icon) ta.push(`blanc:icon="${esc(ed.icon)}"`);
                if (ed.confirm) ta.push(`blanc:confirm="true"`);
                if (ed.confirmText) ta.push(`blanc:confirmText="${esc(ed.confirmText)}"`);
                if (ed.roles) ta.push(`blanc:roles="${esc(ed.roles)}"`);
                if (ed.hotkey) ta.push(`blanc:hotkey="${esc(ed.hotkey)}"`);
                xml += `    <transition ${ta.join(' ')} />\n`;
            }
            xml += `  </${tag}>\n\n`;
        }
    }

    xml += `</scxml>`;
    return xml;
}

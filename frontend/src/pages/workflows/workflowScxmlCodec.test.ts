import { describe, expect, it } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import { graphToScxml, type WorkflowNodeData, type WorkflowEdgeData } from './workflowScxmlCodec';

// FSM-JOB-ACTIONS-001 — the Workflow Builder now carries three new per-transition attributes
// (blanc:button / blanc:variant / blanc:op) so that job-status buttons can be driven entirely by
// the published FSM instead of the removed hardcoded /enroute /start /complete routes. These tests
// pin the ENCODE side (graph → SCXML) that persists an editor's choices. The parse side relies on
// the browser DOMParser, which isn't available under the `node` test environment.

function node(id: string, label: string, isFinal = false, isInitial = false): Node<WorkflowNodeData> {
    return {
        id,
        type: isFinal ? 'workflowFinal' : 'workflowState',
        position: { x: 0, y: 0 },
        data: { label, statusName: label, stateId: id, isFinal, isInitial },
    };
}

function edge(source: string, target: string, data: Partial<WorkflowEdgeData>): Edge {
    const full: WorkflowEdgeData = {
        event: '', isAction: false, label: '', icon: '', confirm: false, confirmText: '',
        order: null, roles: '', hotkey: '', ...data,
    };
    return { id: `${source}--${full.event}--${target}`, source, target, data: full } as Edge;
}

const nodes = [
    node('submitted', 'Submitted', false, true),
    node('on_the_way', 'On the way'),
    node('waiting', 'Waiting for parts'),
    node('waiting2', 'Follow Up with Client'),
    node('done', 'Job is Done', true),
];

const edges: Edge[] = [
    // Prominent button WITH an op (the ETA-SMS side effect that replaced the /enroute route).
    edge('submitted', 'on_the_way', {
        event: 'go_on_the_way', isAction: true, label: 'On the way',
        order: 1, button: true, variant: 'primary', op: 'notify_on_the_way',
    }),
    // Prominent button, NO op (a pure status change — the default when the owner sets nothing).
    edge('on_the_way', 'done', {
        event: 'finish', isAction: true, label: 'Complete job',
        order: 1, button: true, variant: 'success',
    }),
    // Explicitly demoted to menu-only (button === false must survive the round-trip).
    edge('submitted', 'waiting', {
        event: 'hold', isAction: true, label: 'Hold', order: 2, button: false,
    }),
    // Unset button (undefined) — encode must OMIT blanc:button so the server default applies.
    edge('submitted', 'waiting2', {
        event: 'silent', isAction: true, label: 'Silent', order: 3,
    }),
];

describe('graphToScxml — FSM-JOB-ACTIONS-001 button/variant/op encoding', () => {
    const xml = graphToScxml(nodes, edges, 'submitted', 'job', 'Job');

    it('persists the op only where one was chosen', () => {
        expect(xml).toContain('blanc:op="notify_on_the_way"');
        // Exactly one op in the whole machine — the no-op "Complete job" must not invent one.
        expect((xml.match(/blanc:op=/g) || []).length).toBe(1);
    });

    it('persists the chosen button variants', () => {
        expect(xml).toContain('blanc:variant="primary"');
        expect(xml).toContain('blanc:variant="success"');
    });

    it('writes explicit button flags and OMITS the attribute when unset', () => {
        // go_on_the_way + finish are explicit true; hold is explicit false; silent is omitted.
        expect((xml.match(/blanc:button="true"/g) || []).length).toBe(2);
        expect(xml).toContain('blanc:button="false"');
        expect((xml.match(/blanc:button=/g) || []).length).toBe(3); // 4th (silent) omitted, not defaulted
    });

    it('keeps every transition — nothing is dropped by the new attrs', () => {
        for (const event of ['go_on_the_way', 'finish', 'hold', 'silent']) {
            expect(xml).toContain(`event="${event}"`);
        }
    });
});

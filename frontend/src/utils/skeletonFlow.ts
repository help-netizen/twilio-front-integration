import type { CallFlowNode, CallFlowTransition, CallFlowGraph } from '../types/telephony';

/**
 * Creates the canonical skeleton v2 flow for a Phone Number Group.
 *
 * Visible states (5):
 *   Start → Hours Check → Current Group (BH) → Voicemail BH
 *                        → Voicemail AH
 *
 * Hidden final states (3):
 *   sk-done-routed, sk-done-voicemail-business-hours, sk-done-voicemail-after-hours
 *
 * BH/AH are labeled edges from Hours Check, not standalone nodes.
 */
export function createSkeletonFlow(groupName: string): CallFlowGraph {
    const states: CallFlowNode[] = [
        // ── Visible states ──
        {
            id: 'sk-start', name: 'Start', kind: 'start', isInitial: true,
            protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false
        },

        {
            id: 'sk-hours-check', name: 'Hours Check', kind: 'branch',
            protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false
        },

        {
            id: 'sk-current-group', name: groupName, kind: 'queue',
            protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false,
            labelExpr: 'currentGroupName', groupRef: 'group.current',
            config: { queue_name: 'group_agents', timeout_sec: 120 }
        },

        {
            id: 'sk-vm-business-hours', name: 'Voicemail', kind: 'voicemail',
            protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false,
            uiTerminal: true, config: { greeting: 'missed_call', branchKey: 'business_hours' }
        },

        {
            id: 'sk-vm-after-hours', name: 'Voicemail', kind: 'voicemail',
            protected: true, system: true, immutable: true, deletable: false, renamable: false, draggable: false,
            uiTerminal: true, config: { greeting: 'after_hours', branchKey: 'after_hours' }
        },

        // ── Hidden final states ──
        {
            id: 'sk-done-routed', name: 'Done', kind: 'final',
            protected: true, system: true, hidden: true
        },

        {
            id: 'sk-done-voicemail-business-hours', name: 'Done', kind: 'final',
            protected: true, system: true, hidden: true
        },

        {
            id: 'sk-done-voicemail-after-hours', name: 'Done', kind: 'final',
            protected: true, system: true, hidden: true
        },
    ];

    const transitions: CallFlowTransition[] = [
        // Start → Hours Check (eventless, hidden)
        {
            id: 'skt-entry', from_state_id: 'sk-start', to_state_id: 'sk-hours-check',
            system: true, immutable: true, deletable: false, hidden: true,
            edgeRole: 'entry', transitionMode: 'eventless'
        },

        // Hours Check → Current Group (Business Hours branch)
        {
            id: 'skt-bh', from_state_id: 'sk-hours-check', to_state_id: 'sk-current-group',
            label: 'Business Hours',
            system: true, immutable: true, deletable: false,
            edgeLabel: 'Business Hours', branchKey: 'business_hours',
            insertable: true, insertMode: 'between',
            transitionMode: 'conditional', condExpr: 'isBusinessHours === true'
        },

        // Hours Check → Voicemail AH (After Hours branch)
        {
            id: 'skt-ah', from_state_id: 'sk-hours-check', to_state_id: 'sk-vm-after-hours',
            label: 'After Hours',
            system: true, immutable: true, deletable: false,
            edgeLabel: 'After Hours', branchKey: 'after_hours',
            insertable: true, insertMode: 'between',
            transitionMode: 'conditional', condExpr: 'isBusinessHours === false'
        },

        // Current Group → Voicemail BH (not answered / timeout)
        {
            id: 'skt-fallback', from_state_id: 'sk-current-group', to_state_id: 'sk-vm-business-hours',
            label: 'Not answered / timeout',
            system: true, immutable: true, deletable: false,
            edgeLabel: 'Not answered / timeout', edgeRole: 'fallback',
            insertable: true, insertMode: 'between',
            transitionMode: 'event', event_key: 'queue.timeout queue.not_answered queue.failed'
        },

        // Current Group → Done Routed (success, hidden)
        {
            id: 'skt-success', from_state_id: 'sk-current-group', to_state_id: 'sk-done-routed',
            system: true, immutable: true, hidden: true,
            edgeRole: 'success', transitionMode: 'event', event_key: 'queue.connected call.handoff'
        },

        // VM Business Hours → Done (completion, hidden)
        {
            id: 'skt-vm-bh-done', from_state_id: 'sk-vm-business-hours', to_state_id: 'sk-done-voicemail-business-hours',
            system: true, immutable: true, hidden: true,
            edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed'
        },

        // VM After Hours → Done (completion, hidden)
        {
            id: 'skt-vm-ah-done', from_state_id: 'sk-vm-after-hours', to_state_id: 'sk-done-voicemail-after-hours',
            system: true, immutable: true, hidden: true,
            edgeRole: 'completion', transitionMode: 'event', event_key: 'voicemail.recorded voicemail.completed'
        },
    ];

    return { states, transitions };
}

/** IDs of system-required skeleton nodes (visible + hidden) */
export const SKELETON_NODE_IDS = new Set([
    'sk-start', 'sk-hours-check', 'sk-current-group',
    'sk-vm-business-hours', 'sk-vm-after-hours',
    'sk-done-routed', 'sk-done-voicemail-business-hours', 'sk-done-voicemail-after-hours',
]);

/** IDs of system-immutable edge connections */
export const SKELETON_EDGE_IDS = new Set([
    'skt-entry', 'skt-bh', 'skt-ah', 'skt-fallback',
    'skt-success', 'skt-vm-bh-done', 'skt-vm-ah-done',
]);

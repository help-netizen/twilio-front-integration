import type { CallFlowGraph } from '../../types/telephony';

// Shared User Group data (used by list page, detail page, and builder)
export interface ScheduleDay { day: string; open: string; close: string }
export interface UserGroupData {
    id: string;
    name: string;
    desc: string;
    strategy: string;
    members: { id: string; name: string; status: string }[];
    numbers: { id: string; number: string; friendly_name: string }[];
    schedule: { timezone: string; hours: ScheduleDay[] };
    flow: { id: string; status: 'draft' | 'published'; updated_at: string; graph: CallFlowGraph };
}

export const USER_GROUPS: UserGroupData[] = [
    {
        id: 'ug-1', name: 'Sales Team', desc: 'All sales agents', strategy: 'Round Robin',
        members: [
            { id: 'ag-1', name: 'Sarah Johnson', status: 'available' },
            { id: 'ag-2', name: 'Mike Chen', status: 'on_call' },
        ],
        numbers: [
            { id: 'pn-1', number: '+1 (617) 555-0101', friendly_name: 'Main Line' },
            { id: 'pn-2', number: '+1 (617) 555-0102', friendly_name: 'Sales Line' },
        ],
        schedule: {
            timezone: 'America/New_York',
            hours: [
                { day: 'Mon', open: '09:00', close: '18:00' }, { day: 'Tue', open: '09:00', close: '18:00' },
                { day: 'Wed', open: '09:00', close: '18:00' }, { day: 'Thu', open: '09:00', close: '18:00' },
                { day: 'Fri', open: '09:00', close: '17:00' }, { day: 'Sat', open: 'Closed', close: '' },
                { day: 'Sun', open: 'Closed', close: '' },
            ],
        },
        flow: {
            id: 'cf-1', status: 'published', updated_at: '2026-03-06',
            graph: {
                states: [
                    { id: 's-start', name: 'Call Received', kind: 'start', isInitial: true },
                    { id: 's-greeting', name: 'Welcome Greeting', kind: 'greeting' },
                    { id: 's-hours', name: 'Business Hours?', kind: 'branch' },
                    { id: 's-menu', name: 'Main Menu', kind: 'menu' },
                    { id: 's-queue', name: 'Agent Queue', kind: 'queue' },
                    { id: 's-voicemail', name: 'Leave Message', kind: 'voicemail' },
                    { id: 's-hangup', name: 'End Call', kind: 'hangup' },
                ],
                transitions: [
                    { id: 't-1', from_state_id: 's-start', to_state_id: 's-greeting', label: 'answer' },
                    { id: 't-2', from_state_id: 's-greeting', to_state_id: 's-hours', label: 'check hours' },
                    { id: 't-3', from_state_id: 's-hours', to_state_id: 's-menu', label: 'open' },
                    { id: 't-4', from_state_id: 's-hours', to_state_id: 's-voicemail', label: 'closed' },
                    { id: 't-5', from_state_id: 's-menu', to_state_id: 's-queue', label: 'selected' },
                    { id: 't-6', from_state_id: 's-queue', to_state_id: 's-hangup', label: 'connected' },
                    { id: 't-7', from_state_id: 's-queue', to_state_id: 's-voicemail', label: 'timeout' },
                    { id: 't-8', from_state_id: 's-voicemail', to_state_id: 's-hangup', label: 'recorded' },
                ],
            },
        },
    },
    {
        id: 'ug-2', name: 'Support Team', desc: 'Technical support', strategy: 'Simultaneous',
        members: [
            { id: 'ag-3', name: 'Lisa Park', status: 'away' },
            { id: 'ag-4', name: 'Tom Rivera', status: 'available' },
        ],
        numbers: [
            { id: 'pn-3', number: '+1 (617) 555-0103', friendly_name: 'Support Line' },
        ],
        schedule: {
            timezone: 'America/New_York',
            hours: [
                { day: 'Mon', open: '08:00', close: '22:00' }, { day: 'Tue', open: '08:00', close: '22:00' },
                { day: 'Wed', open: '08:00', close: '22:00' }, { day: 'Thu', open: '08:00', close: '22:00' },
                { day: 'Fri', open: '08:00', close: '20:00' }, { day: 'Sat', open: '10:00', close: '16:00' },
                { day: 'Sun', open: 'Closed', close: '' },
            ],
        },
        flow: {
            id: 'cf-2', status: 'draft', updated_at: '2026-03-07',
            graph: {
                states: [
                    { id: 's-start', name: 'Call Received', kind: 'start', isInitial: true },
                    { id: 's-msg', name: 'After Hours Message', kind: 'play_audio' },
                    { id: 's-vm', name: 'Voicemail', kind: 'voicemail' },
                    { id: 's-end', name: 'End Call', kind: 'hangup' },
                ],
                transitions: [
                    { id: 't-1', from_state_id: 's-start', to_state_id: 's-msg', label: 'answer' },
                    { id: 't-2', from_state_id: 's-msg', to_state_id: 's-vm', label: 'played' },
                    { id: 't-3', from_state_id: 's-vm', to_state_id: 's-end', label: 'recorded' },
                ],
            },
        },
    },
];

export const STATUS_COLORS: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' },
    on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' },
    offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

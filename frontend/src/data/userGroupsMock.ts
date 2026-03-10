import type { CallFlowGraph } from '../types/telephony';
import { createSkeletonFlow } from '../utils/skeletonFlow';

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
            graph: createSkeletonFlow('Sales Team'),
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
            graph: createSkeletonFlow('Support Team'),
        },
    },
];

export const STATUS_COLORS: Record<string, { bg: string; dot: string }> = {
    available: { bg: '#d1fae5', dot: '#10b981' },
    on_call: { bg: '#dbeafe', dot: '#3b82f6' },
    away: { bg: '#fef3c7', dot: '#f59e0b' },
    offline: { bg: '#f3f4f6', dot: '#9ca3af' },
};

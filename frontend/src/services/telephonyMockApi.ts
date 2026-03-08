/**
 * Mock API for Telephony Route Manager — will be replaced with real API calls later.
 */
import type {
    PhoneNumberGroup, PhoneNumberGroupDetail, PhoneNumberGroupMembership,
    Schedule, ScheduleDetail, ScheduleInterval, ScheduleException,
    UserGroup, UserGroupDetail, UserGroupMember,
    RouteManagerKPIs,
} from '../types/telephony';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));
let nextId = 100;
const uid = () => String(nextId++);

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockGroups: PhoneNumberGroupDetail[] = [
    {
        id: '1', company_id: 'c1', name: 'Dispatch', is_default: true, timezone: 'America/New_York',
        active_flow_version_id: 'fv-1', active_flow_name: 'Main Routing', active_flow_version: 3,
        schedule_id: 's-1', schedule_name: 'Business Hours', status: 'active',
        numbers_count: 3, queued_calls_now: 2, unanswered_today: 1, voicemails_today: 0,
        created_at: '2026-01-15T10:00:00Z', updated_at: '2026-03-01T12:00:00Z',
        numbers: [
            { id: 'n1', group_id: '1', phone_number: '+16175551234', friendly_name: 'Main Line', created_at: '2026-01-15T10:00:00Z' },
            { id: 'n2', group_id: '1', phone_number: '+16175555678', friendly_name: 'Support', created_at: '2026-02-01T10:00:00Z' },
            { id: 'n3', group_id: '1', phone_number: '+16175559999', friendly_name: 'Sales', created_at: '2026-02-15T10:00:00Z' },
        ],
        runtime_summary: { queued_now: 2, avg_wait_time_sec: 45, unanswered_today: 1, voicemails_today: 0, last_inbound_at: '2026-03-08T15:30:00Z' },
    },
    {
        id: '2', company_id: 'c1', name: 'After-Hours', is_default: false, timezone: 'America/New_York',
        active_flow_version_id: 'fv-2', active_flow_name: 'After Hours Flow', active_flow_version: 1,
        schedule_id: 's-2', schedule_name: 'After Hours Schedule', status: 'active',
        numbers_count: 1, queued_calls_now: 0, unanswered_today: 3, voicemails_today: 2,
        created_at: '2026-02-01T10:00:00Z', updated_at: '2026-03-05T10:00:00Z',
        numbers: [
            { id: 'n4', group_id: '2', phone_number: '+16175554321', friendly_name: 'Emergency', created_at: '2026-02-01T10:00:00Z' },
        ],
        runtime_summary: { queued_now: 0, avg_wait_time_sec: 0, unanswered_today: 3, voicemails_today: 2, last_inbound_at: '2026-03-08T02:15:00Z' },
    },
];

const mockSchedules: ScheduleDetail[] = [
    {
        id: 's-1', company_id: 'c1', name: 'Business Hours', timezone: 'America/New_York', status: 'active',
        intervals_count: 5, exceptions_count: 1, used_by_groups_count: 1, is_open_now: true,
        created_at: '2026-01-10T10:00:00Z', updated_at: '2026-03-01T10:00:00Z',
        intervals: [
            { id: 'i1', schedule_id: 's-1', day_of_week: 1, start_time: '09:00', end_time: '17:00' },
            { id: 'i2', schedule_id: 's-1', day_of_week: 2, start_time: '09:00', end_time: '17:00' },
            { id: 'i3', schedule_id: 's-1', day_of_week: 3, start_time: '09:00', end_time: '17:00' },
            { id: 'i4', schedule_id: 's-1', day_of_week: 4, start_time: '09:00', end_time: '17:00' },
            { id: 'i5', schedule_id: 's-1', day_of_week: 5, start_time: '09:00', end_time: '17:00' },
        ],
        exceptions: [
            { id: 'e1', schedule_id: 's-1', date: '2026-12-25', is_closed: true, start_time: null, end_time: null, label: 'Christmas Day' },
        ],
        linked_groups: [{ id: '1', name: 'Dispatch' }],
    },
    {
        id: 's-2', company_id: 'c1', name: 'After Hours Schedule', timezone: 'America/New_York', status: 'active',
        intervals_count: 7, exceptions_count: 0, used_by_groups_count: 1, is_open_now: false,
        created_at: '2026-02-01T10:00:00Z', updated_at: '2026-03-01T10:00:00Z',
        intervals: [
            { id: 'i6', schedule_id: 's-2', day_of_week: 0, start_time: '00:00', end_time: '23:59' },
            { id: 'i7', schedule_id: 's-2', day_of_week: 1, start_time: '17:00', end_time: '23:59' },
            { id: 'i8', schedule_id: 's-2', day_of_week: 2, start_time: '17:00', end_time: '23:59' },
            { id: 'i9', schedule_id: 's-2', day_of_week: 3, start_time: '17:00', end_time: '23:59' },
            { id: 'i10', schedule_id: 's-2', day_of_week: 4, start_time: '17:00', end_time: '23:59' },
            { id: 'i11', schedule_id: 's-2', day_of_week: 5, start_time: '17:00', end_time: '23:59' },
            { id: 'i12', schedule_id: 's-2', day_of_week: 6, start_time: '00:00', end_time: '23:59' },
        ],
        exceptions: [],
        linked_groups: [{ id: '2', name: 'After-Hours' }],
    },
];

const mockUserGroups: UserGroupDetail[] = [
    {
        id: 'ug-1', company_id: 'c1', name: 'Dispatch Team', routing_mode: 'queue_pull', strategy: 'round_robin',
        offer_timeout_sec: 20, per_user_capacity: 1, fallback_action: 'voicemail',
        members_count: 3, active_members_now: 2, status: 'active',
        created_at: '2026-01-15T10:00:00Z', updated_at: '2026-03-01T10:00:00Z',
        members: [
            { id: 'm1', user_group_id: 'ug-1', user_id: 'u1', user_name: 'John Smith', user_email: 'john@blanc.app', priority: 1, is_active: true, is_online: true, created_at: '2026-01-15T10:00:00Z' },
            { id: 'm2', user_group_id: 'ug-1', user_id: 'u2', user_name: 'Jane Doe', user_email: 'jane@blanc.app', priority: 2, is_active: true, is_online: true, created_at: '2026-01-15T10:00:00Z' },
            { id: 'm3', user_group_id: 'ug-1', user_id: 'u3', user_name: 'Bob Wilson', user_email: 'bob@blanc.app', priority: 3, is_active: true, is_online: false, created_at: '2026-02-01T10:00:00Z' },
        ],
    },
    {
        id: 'ug-2', company_id: 'c1', name: 'Sales Team', routing_mode: 'auto_offer', strategy: 'longest_idle',
        offer_timeout_sec: 15, per_user_capacity: 2, fallback_action: 'voicemail',
        members_count: 2, active_members_now: 1, status: 'active',
        created_at: '2026-02-01T10:00:00Z', updated_at: '2026-03-05T10:00:00Z',
        members: [
            { id: 'm4', user_group_id: 'ug-2', user_id: 'u4', user_name: 'Alice Brown', user_email: 'alice@blanc.app', priority: 1, is_active: true, is_online: true, created_at: '2026-02-01T10:00:00Z' },
            { id: 'm5', user_group_id: 'ug-2', user_id: 'u5', user_name: 'Charlie Davis', user_email: 'charlie@blanc.app', priority: 2, is_active: true, is_online: false, created_at: '2026-02-15T10:00:00Z' },
        ],
    },
];

// ─── Public Mock API ──────────────────────────────────────────────────────────

export const telephonyApi = {
    // KPIs
    async getOverviewKPIs(): Promise<RouteManagerKPIs> {
        await delay();
        return {
            active_groups: mockGroups.filter(g => g.status === 'active').length,
            active_flows: mockGroups.filter(g => g.active_flow_version_id).length,
            queued_now: mockGroups.reduce((s, g) => s + g.queued_calls_now, 0),
            unanswered_today: mockGroups.reduce((s, g) => s + g.unanswered_today, 0),
            voicemails_today: mockGroups.reduce((s, g) => s + g.voicemails_today, 0),
        };
    },

    // Phone Number Groups
    async getPhoneNumberGroups(): Promise<PhoneNumberGroup[]> {
        await delay();
        return mockGroups.map(({ numbers, runtime_summary, ...g }) => g);
    },
    async getPhoneNumberGroup(id: string): Promise<PhoneNumberGroupDetail | null> {
        await delay();
        return mockGroups.find(g => g.id === id) || null;
    },
    async createPhoneNumberGroup(data: { name: string; timezone: string }): Promise<PhoneNumberGroup> {
        await delay(500);
        const g: PhoneNumberGroupDetail = {
            id: uid(), company_id: 'c1', name: data.name, is_default: false, timezone: data.timezone,
            active_flow_version_id: null, active_flow_name: null, active_flow_version: null,
            schedule_id: null, schedule_name: null, status: 'active',
            numbers_count: 0, queued_calls_now: 0, unanswered_today: 0, voicemails_today: 0,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            numbers: [], runtime_summary: { queued_now: 0, avg_wait_time_sec: 0, unanswered_today: 0, voicemails_today: 0, last_inbound_at: null },
        };
        mockGroups.push(g);
        return g;
    },

    // Schedules
    async getSchedules(): Promise<Schedule[]> {
        await delay();
        return mockSchedules.map(({ intervals, exceptions, linked_groups, ...s }) => s);
    },
    async getSchedule(id: string): Promise<ScheduleDetail | null> {
        await delay();
        return mockSchedules.find(s => s.id === id) || null;
    },
    async createSchedule(data: { name: string; timezone: string }): Promise<Schedule> {
        await delay(500);
        const s: ScheduleDetail = {
            id: uid(), company_id: 'c1', name: data.name, timezone: data.timezone, status: 'active',
            intervals_count: 0, exceptions_count: 0, used_by_groups_count: 0, is_open_now: false,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            intervals: [], exceptions: [], linked_groups: [],
        };
        mockSchedules.push(s);
        return s;
    },

    // User Groups
    async getUserGroups(): Promise<UserGroup[]> {
        await delay();
        return mockUserGroups.map(({ members, ...g }) => g);
    },
    async getUserGroup(id: string): Promise<UserGroupDetail | null> {
        await delay();
        return mockUserGroups.find(g => g.id === id) || null;
    },
    async createUserGroup(data: { name: string; routing_mode: string; strategy: string }): Promise<UserGroup> {
        await delay(500);
        const g: UserGroupDetail = {
            id: uid(), company_id: 'c1', name: data.name, routing_mode: data.routing_mode as any,
            strategy: data.strategy as any, offer_timeout_sec: 20, per_user_capacity: 1,
            fallback_action: 'voicemail', members_count: 0, active_members_now: 0, status: 'active',
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(), members: [],
        };
        mockUserGroups.push(g);
        return g;
    },
};

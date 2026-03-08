// ─── Phone Number Groups ──────────────────────────────────────────────────────

export interface PhoneNumberGroup {
    id: string;
    company_id: string;
    name: string;
    is_default: boolean;
    timezone: string;
    active_flow_version_id: string | null;
    active_flow_name: string | null;
    active_flow_version: number | null;
    schedule_id: string | null;
    schedule_name: string | null;
    status: 'active' | 'archived';
    numbers_count: number;
    queued_calls_now: number;
    unanswered_today: number;
    voicemails_today: number;
    created_at: string;
    updated_at: string;
}

export interface PhoneNumberGroupMembership {
    id: string;
    group_id: string;
    phone_number: string;
    friendly_name?: string;
    created_at: string;
}

export interface PhoneNumberGroupDetail extends PhoneNumberGroup {
    numbers: PhoneNumberGroupMembership[];
    runtime_summary: {
        queued_now: number;
        avg_wait_time_sec: number;
        unanswered_today: number;
        voicemails_today: number;
        last_inbound_at: string | null;
    };
}

// ─── Schedules ────────────────────────────────────────────────────────────────

export interface Schedule {
    id: string;
    company_id: string;
    name: string;
    timezone: string;
    status: 'active' | 'archived';
    intervals_count: number;
    exceptions_count: number;
    used_by_groups_count: number;
    is_open_now: boolean;
    created_at: string;
    updated_at: string;
}

export interface ScheduleInterval {
    id: string;
    schedule_id: string;
    day_of_week: number; // 0=Sun..6=Sat
    start_time: string;  // "HH:MM"
    end_time: string;    // "HH:MM"
}

export interface ScheduleException {
    id: string;
    schedule_id: string;
    date: string;        // "YYYY-MM-DD"
    is_closed: boolean;
    start_time: string | null;
    end_time: string | null;
    label: string;
}

export interface ScheduleDetail extends Schedule {
    intervals: ScheduleInterval[];
    exceptions: ScheduleException[];
    linked_groups: { id: string; name: string }[];
}

// ─── User Groups ──────────────────────────────────────────────────────────────

export type RoutingMode = 'queue_pull' | 'auto_offer';
export type RoutingStrategy = 'round_robin' | 'longest_idle' | 'fixed_priority';
export type FallbackAction = 'voicemail' | 'forward_external' | 'hangup';

export interface UserGroup {
    id: string;
    company_id: string;
    name: string;
    routing_mode: RoutingMode;
    strategy: RoutingStrategy;
    offer_timeout_sec: number;
    per_user_capacity: number;
    fallback_action: FallbackAction;
    members_count: number;
    active_members_now: number;
    status: 'active' | 'archived';
    created_at: string;
    updated_at: string;
}

export interface UserGroupMember {
    id: string;
    user_group_id: string;
    user_id: string;
    user_name: string;
    user_email: string;
    priority: number;
    is_active: boolean;
    is_online: boolean;
    created_at: string;
}

export interface UserGroupDetail extends UserGroup {
    members: UserGroupMember[];
}

// ─── Route Manager Overview KPIs ──────────────────────────────────────────────

export interface RouteManagerKPIs {
    active_groups: number;
    active_flows: number;
    queued_now: number;
    unanswered_today: number;
    voicemails_today: number;
}

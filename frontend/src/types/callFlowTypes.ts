// Shared enum for node kinds used by both types and UI
export type CallFlowNodeKind =
    | 'start'
    | 'business_hours_root'
    | 'greeting'
    | 'route_user_group'
    | 'route_user'
    | 'forward_external'
    | 'queue'
    | 'voicemail'
    | 'hangup'
    | 'final';

export const NODE_KIND_META: Record<CallFlowNodeKind, { label: string; color: string; icon: string }> = {
    start: { label: 'Start', color: '#6366f1', icon: '▶' },
    business_hours_root: { label: 'Business Hours', color: '#10b981', icon: '🕐' },
    greeting: { label: 'Greeting', color: '#3b82f6', icon: '👋' },
    route_user_group: { label: 'Route to Group', color: '#8b5cf6', icon: '👥' },
    route_user: { label: 'Route to User', color: '#a855f7', icon: '👤' },
    forward_external: { label: 'Forward', color: '#f97316', icon: '📞' },
    queue: { label: 'Queue', color: '#eab308', icon: '⏳' },
    voicemail: { label: 'Voicemail', color: '#14b8a6', icon: '📧' },
    hangup: { label: 'Hangup', color: '#ef4444', icon: '🔴' },
    final: { label: 'End', color: '#6b7280', icon: '⏹' },
};

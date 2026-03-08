import React from 'react';

export const contactDetailStyles = {
    labelStyle: {
        fontSize: '11px',
        fontWeight: 600,
        color: '#94a3b8',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
    } as React.CSSProperties,

    sectionTitleStyle: {
        fontSize: '14px',
        fontWeight: 600,
        color: '#374151',
        marginBottom: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
    } as React.CSSProperties,
};

export function InfoRow({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 0' }}>
            {icon && (
                <div style={{ color: '#94a3b8', marginTop: '1px', flexShrink: 0 }}>
                    {icon}
                </div>
            )}
            <div style={{ minWidth: 0 }}>
                <div style={contactDetailStyles.labelStyle}>{label}</div>
                <div style={{
                    fontSize: '14px', color: value ? '#111827' : '#cbd5e1',
                    fontWeight: value ? 500 : 400, wordBreak: 'break-word',
                }}>
                    {value || '—'}
                </div>
            </div>
        </div>
    );
}

export function formatPhone(phone: string | null): string {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }
    return phone;
}

export function getLeadStatusColor(status: string): string {
    switch (status) {
        case 'New':
        case 'Submitted': return '#3b82f6';
        case 'Contacted': return '#8b5cf6';
        case 'Qualified': return '#10b981';
        case 'Proposal Sent': return '#f59e0b';
        case 'Negotiation': return '#f97316';
        case 'Converted': return '#059669';
        case 'Lost': return '#ef4444';
        default: return '#6b7280';
    }
}

export function getJobStatusStyle(status: string): { bg: string; color: string } {
    switch (status) {
        case 'Submitted': return { bg: '#dbeafe', color: '#1e40af' };
        case 'Waiting for parts': return { bg: '#fef3c7', color: '#92400e' };
        case 'Follow Up with Client': return { bg: '#f3e8ff', color: '#6b21a8' };
        case 'Visit completed': return { bg: '#dcfce7', color: '#166534' };
        case 'Job is Done': return { bg: '#e5e7eb', color: '#374151' };
        case 'Rescheduled': return { bg: '#ffedd5', color: '#9a3412' };
        case 'Canceled': return { bg: '#fee2e2', color: '#991b1b' };
        default: return { bg: '#f1f5f9', color: '#475569' };
    }
}

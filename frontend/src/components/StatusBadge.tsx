import React from 'react';

// Status configuration with labels and colors
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
    'in-progress': { label: 'In Progress', color: 'bg-green-500' },
    'ringing': { label: 'Ringing', color: 'bg-blue-500' },
    'initiated': { label: 'Calling', color: 'bg-blue-400' },
    'queued': { label: 'Queued', color: 'bg-gray-400' },
    'completed': { label: 'Completed', color: 'bg-gray-600' },
    'no-answer': { label: 'Missed', color: 'bg-red-500' },
    'busy': { label: 'Busy', color: 'bg-orange-500' },
    'canceled': { label: 'Canceled', color: 'bg-gray-500' },
    'failed': { label: 'Missed', color: 'bg-red-500' }
};

interface StatusBadgeProps {
    status: string;
}

/**
 * StatusBadge - Display call status as a colored badge
 * @param {string} status - Twilio call status
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
    const config = STATUS_CONFIG[status] || {
        label: status,
        color: 'bg-gray-400'
    };

    return (
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium text-white ${config.color}`}>
            {config.label}
        </span>
    );
};

export default StatusBadge;

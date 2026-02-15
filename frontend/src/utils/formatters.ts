// Utility functions for formatting data

export const formatPhoneNumber = (number: string): string => {
    if (!number) return 'Unknown';

    // Remove all non-digit characters
    const cleaned = number.replace(/\D/g, '');

    // US format: +1 (XXX) XXX-XXXX
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }

    // International or other formats
    return number;
};

export const formatDuration = (seconds: number): string => {
    if (!seconds || seconds < 0) return '0s';

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    if (mins > 0) {
        return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
};

export const formatDurationLong = (seconds: number): string => {
    if (!seconds || seconds < 0) return '0 seconds';

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (mins > 0) parts.push(`${mins} minute${mins > 1 ? 's' : ''}`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs} second${secs !== 1 ? 's' : ''}`);

    return parts.join(' ');
};

export const formatDateTime = (timestamp: number | string): string => {
    const date = new Date(timestamp);

    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
};

export const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return formatDateTime(timestamp);
};

export const getCallStatusColor = (status: string): 'success' | 'error' | 'warning' | 'info' => {
    switch (status) {
        case 'completed':
            return 'success';
        case 'busy':
            return 'warning';
        case 'no-answer':
        case 'failed':
        case 'canceled':
            return 'error';
        default:
            return 'info';
    }
};

/**
 * Format timestamp as absolute time (e.g., "Feb 5, 11:39 AM")
 */
export function formatAbsoluteTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    const options: Intl.DateTimeFormatOptions = {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    };

    // If same year, don't show year
    if (date.getFullYear() !== now.getFullYear()) {
        options.year = 'numeric';
    }

    return date.toLocaleString('en-US', options);
}

/**
 * Normalize phone number to digits only for comparison
 * Handles various formats: "+1 (617) 823-2990", "617-823-2990", "6178232990" all → "16178232990" or "6178232990"
 */
export function normalizePhoneNumber(phone: string): string {
    if (!phone) return '';
    // Remove all non-digit characters
    return phone.replace(/\D/g, '');
}

/**
 * Create clickable tel: link from phone number
 * Wraps formatted phone number in HTML anchor tag
 */
export function createPhoneLink(phone: string): string {
    if (!phone) return 'Unknown';

    // Format the phone number for display
    const formatted = formatPhoneNumber(phone);

    // Create clean phone number for tel: protocol (only digits and +)
    const cleanPhone = phone.replace(/[^\d+]/g, '');

    // Return as HTML link
    return `<a href="tel:${cleanPhone}">${formatted}</a>`;
}

export const getCallDirectionEmoji = (direction: string): string => {
    return direction.includes('inbound') ? '📞' : '📱';
};

export const getCallDirectionLabel = (direction: string): string => {
    return direction.includes('inbound') ? 'Incoming' : 'Outgoing';
};

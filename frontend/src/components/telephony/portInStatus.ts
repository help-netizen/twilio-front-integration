export const TERMINAL_PORT_IN_STATUSES = new Set(['completed', 'canceled', 'failed']);

export const PORTING_UNAVAILABLE_NOTICE = "Number transfers aren't automated for this account yet — contact support and we'll run the port for you";

interface PortInStatusRequest {
    status: string;
    twilio_status: string | null;
    signature_request_url: string | null;
    representative_email?: string;
}

export function portInStatusLabel(request: PortInStatusRequest): string {
    if (request.twilio_status === 'PORTING_UNAVAILABLE') return PORTING_UNAVAILABLE_NOTICE;
    if (request.signature_request_url && !TERMINAL_PORT_IN_STATUSES.has(request.status)) {
        return `Waiting for your signature — check ${request.representative_email || 'your email'}`;
    }

    switch (request.status) {
        case 'submitted':
            return 'Transfer request submitted';
        case 'pending':
            return 'Transfer submitted — waiting for carrier review';
        case 'in_review':
            return 'In review with your current carrier';
        case 'action_required':
            return 'Action needed — check your email for next steps';
        case 'completed':
            return 'Completed — the number is live';
        case 'canceled':
            return 'Canceled — the transfer will not continue';
        case 'failed':
            return 'Transfer failed — contact support for help';
        default:
            return 'Transfer is being processed';
    }
}

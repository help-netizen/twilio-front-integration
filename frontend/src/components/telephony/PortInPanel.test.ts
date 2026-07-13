import { describe, expect, it } from 'vitest';
import { portInStatusLabel } from './portInStatus';

const request = {
    twilio_status: null,
    signature_request_url: null,
    representative_email: undefined,
};

describe('portInStatusLabel', () => {
    it('maps carrier lifecycle statuses to customer-facing copy', () => {
        expect(portInStatusLabel({ ...request, status: 'submitted' })).toBe('Transfer request submitted');
        expect(portInStatusLabel({ ...request, status: 'pending' })).toBe('Transfer submitted — waiting for carrier review');
        expect(portInStatusLabel({ ...request, status: 'in_review' })).toBe('In review with your current carrier');
        expect(portInStatusLabel({ ...request, status: 'action_required' })).toBe('Action needed — check your email for next steps');
        expect(portInStatusLabel({ ...request, status: 'completed' })).toBe('Completed — the number is live');
        expect(portInStatusLabel({ ...request, status: 'canceled' })).toBe('Canceled — the transfer will not continue');
        expect(portInStatusLabel({ ...request, status: 'failed' })).toBe('Transfer failed — contact support for help');
    });

    it('prioritizes the signature action and uses the session email when available', () => {
        expect(portInStatusLabel({
            ...request,
            status: 'action_required',
            signature_request_url: 'https://example.test/sign',
            representative_email: 'owner@example.test',
        })).toBe('Waiting for your signature — check owner@example.test');
    });

    it('surfaces the honest account fallback for unavailable porting', () => {
        expect(portInStatusLabel({
            ...request,
            status: 'action_required',
            twilio_status: 'PORTING_UNAVAILABLE',
        })).toBe("Number transfers aren't automated for this account yet — contact support and we'll run the port for you");
    });
});

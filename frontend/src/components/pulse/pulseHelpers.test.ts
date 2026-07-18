import { describe, expect, it } from 'vitest';
import {
    callToCallData,
    getPulseCallIconKind,
    getPulseCallStatusLabel,
    getPulsePrimaryText,
    isAiAnsweredBy,
    isMissedInboundStatus,
} from './pulseHelpers';

describe('Pulse AI call icon selection', () => {
    it('matches only the canonical answered_by value', () => {
        expect(isAiAnsweredBy('ai')).toBe(true);

        for (const value of ['AI', ' ai ', 'vapi', 'bot', 'assistant', 'chairman', 'mail-agent']) {
            expect(isAiAnsweredBy(value)).toBe(false);
        }
        expect(isAiAnsweredBy(null)).toBe(false);
        expect(isAiAnsweredBy(undefined)).toBe(false);
    });

    it('replaces both inbound and outbound arrows with Bot for AI calls', () => {
        expect(getPulseCallIconKind('incoming', 'ai')).toBe('bot');
        expect(getPulseCallIconKind('inbound', 'ai')).toBe('bot');
        expect(getPulseCallIconKind('outgoing', 'ai')).toBe('bot');
        expect(getPulseCallIconKind('outbound-api', 'ai')).toBe('bot');
    });

    it('keeps directional icons for every non-canonical marker', () => {
        expect(getPulseCallIconKind('incoming', 'chairman')).toBe('incoming');
        expect(getPulseCallIconKind('inbound', null)).toBe('incoming');
        expect(getPulseCallIconKind('internal', undefined)).toBe('internal');
        expect(getPulseCallIconKind('outbound-dial', 'vapi')).toBe('outgoing');
    });
});

describe('Pulse blocked call presentation', () => {
    it('maps persisted blocked status without degrading it to completed or missed', () => {
        const call = callToCallData({
            id: 9,
            call_sid: 'CA_blocked',
            direction: 'inbound',
            from_number: '+16175550119',
            to_number: '+15085550001',
            status: 'blocked',
            started_at: '2026-07-18T14:42:00.000Z',
            ended_at: '2026-07-18T14:42:00.000Z',
            duration_sec: 0,
        });

        expect(call.status).toBe('blocked');
        expect(getPulseCallStatusLabel(call.status)).toBe('Blocked');
        expect(getPulseCallIconKind(call.direction, 'ai', call.status)).toBe('blocked');
        expect(isMissedInboundStatus(call.status)).toBe(false);
    });

    it('keeps a resolved contact name as the primary label', () => {
        expect(getPulsePrimaryText({
            isAnonymous: false,
            company: null,
            leadName: null,
            contactName: 'Maya Chen',
            displayName: null,
            formattedPhone: '(617) 555-0119',
        })).toBe('Maya Chen');
    });
});

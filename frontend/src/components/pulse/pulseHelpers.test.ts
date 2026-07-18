import { describe, expect, it } from 'vitest';
import { getPulseCallIconKind, isAiAnsweredBy } from './pulseHelpers';

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

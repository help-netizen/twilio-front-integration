'use strict';

const fs = require('fs');
const path = require('path');
const { extractYelpReplyBody } = require('../../src/services/yelpReplyExtract');

describe('extractYelpReplyBody', () => {
    it('extracts the customer reply from a respondable_email_v2 wrapper', () => {
        const sample = fs.readFileSync(
            path.join(__dirname, '../fixtures/yelp_respondable_v2_sample.txt'),
            'utf8'
        );

        const extracted = extractYelpReplyBody(sample);

        expect(extracted).toContain('444 W 2nd st');
        expect(extracted).toContain('617.312.5457');
        expect(extracted).toMatch(/proceed/i);
        expect(extracted).not.toMatch(/has replied to your message/i);
        expect(extracted).not.toMatch(/Respond Now/i);
        expect(extracted).not.toMatch(/Unsubscribe/i);
        expect(extracted).not.toMatch(/Yelp Inc/i);
        expect(extracted).not.toMatch(/business\.yelp\.com/i);
        expect(extracted).not.toMatch(/[\u00AD\u034F\u200B-\u200D\u2060\uFEFF]/);
    });

    it('extracts the customer request from a first_message_v4 wrapper', () => {
        const sample = fs.readFileSync(
            path.join(__dirname, '../fixtures/yelp_first_message_sample.txt'),
            'utf8'
        );

        const extracted = extractYelpReplyBody(sample);

        expect(extracted).toContain('Thermador');
        expect(extracted).toContain('E19');
        expect(extracted).toContain('444 W 2nd');
        expect(extracted).toContain('02127');
        expect(extracted).toContain('Robert D.');
        expect(extracted).not.toMatch(/You have a new/i);
        expect(extracted).not.toMatch(/Sent to ABC Homes/i);
        expect(extracted).not.toMatch(/2502 Village Rd/i);
        expect(extracted).not.toMatch(/stay responsive/i);
        expect(extracted).not.toMatch(/response rate/i);
        expect(extracted).not.toMatch(/Reply to Robert on Yelp Biz/i);
        expect(extracted).not.toMatch(/I already replied/i);
        expect(extracted).not.toMatch(/In what location do you need the service\?/i);
        expect(extracted).not.toMatch(/https?:\/\//i);
        expect(extracted).not.toContain('[');
    });

    it('returns empty for a notification with no customer-authored content', () => {
        const notification = [
            'Hi Dana S., Robert has replied to your message.',
            '\u034F\u200B\u200C\u200D\u2060\uFEFF\u00AD',
            '| for business',
            'Robert requested a quote from your business.',
            '| Reply to stay eligible for this lead.',
            "What's the best phone number to reach you at?",
            'New Message from Robert',
            '[ Robert D. ](https://www.yelp.com/user_details?id=1)',
            '**Boston, MA**',
            '| 0 | 0 |',
            '---|---',
            'Respond Now',
            'Unsubscribe',
            '© 2026 Yelp Inc. | business.yelp.com',
        ].join('\n');

        expect(extractYelpReplyBody(notification)).toBe('');
    });

    it('preserves already-clean plain text', () => {
        const plain = 'My dishwasher leaks, 617-555-0100';
        expect(extractYelpReplyBody(plain)).toBe(plain);
    });

    it.each([null, undefined, ''])('returns empty for %p without throwing', value => {
        expect(() => extractYelpReplyBody(value)).not.toThrow();
        expect(extractYelpReplyBody(value)).toBe('');
    });
});

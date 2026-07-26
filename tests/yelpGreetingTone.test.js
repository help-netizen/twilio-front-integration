'use strict';

describe('YELP-GRIT-001 · first-reply tone', () => {
    const originalFetch = global.fetch;
    const originalApiKey = process.env.GEMINI_API_KEY;
    const originalProvider = process.env.YELP_GREETING_PROVIDER;

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalApiKey;
        if (originalProvider === undefined) delete process.env.YELP_GREETING_PROVIDER;
        else process.env.YELP_GREETING_PROVIDER = originalProvider;
        jest.resetModules();
        jest.restoreAllMocks();
    });

    it('static fallback opens with Hi and never uses a gratitude opener', async () => {
        delete process.env.GEMINI_API_KEY;
        jest.resetModules();
        const service = require('../backend/src/services/yelpGreetingService');

        const body = await service.buildGreeting({
            name: 'Kim',
            service: 'dishwasher repair',
        });

        expect(body).toBe(
            "Hi Kim, we can take care of your dishwasher repair. What's the best phone number and service address to reach you? We'll line up the earliest window we have."
        );
        expect(body).not.toMatch(/^(?:thanks|thank you)/i);
    });

    it('a stale LLM response beginning with Thanks is normalized to the approved Hi opener', async () => {
        process.env.GEMINI_API_KEY = 'test-key';
        process.env.YELP_GREETING_PROVIDER = 'gemini';
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({
                candidates: [{
                    content: {
                        parts: [{
                            text: "Thanks so much for reaching out! We can take care of your dishwasher repair. What's the best phone number and service address?",
                        }],
                    },
                }],
            }),
        });
        jest.resetModules();
        const service = require('../backend/src/services/yelpGreetingService');

        const body = await service.buildGreeting({
            name: 'Kim',
            service: 'dishwasher repair',
        });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(body).toBe(
            "Hi Kim, We can take care of your dishwasher repair. What's the best phone number and service address?"
        );
        expect(body).not.toMatch(/^(?:thanks|thank you)/i);
    });
});

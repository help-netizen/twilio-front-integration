'use strict';

// ONB-EMAIL-CONNECT-001 — after a successful Google consent:
//   • the FIRST sync starts by itself (no Sync-now click),
//   • mid-onboarding the browser returns to /welcome, a finished company to settings,
//   • a checklist lookup failure falls back to the settings redirect (fail-quiet).

const mockSyncMailbox = jest.fn(() => Promise.resolve());
const mockGetChecklist = jest.fn();

jest.mock('../backend/src/services/emailMailboxService', () => ({
    validateOAuthState: jest.fn(() => ({ company_id: 'co-1', user_id: 'u-1' })),
    exchangeCode: jest.fn(() => Promise.resolve({ access_token: 'tok' })),
    getGmailProfile: jest.fn(() => Promise.resolve({ email_address: 'box@example.com' })),
    connectMailbox: jest.fn(() => Promise.resolve({ id: 'mb-1' })),
}));
jest.mock('../backend/src/services/mail/providerRegistry', () => ({
    get: () => ({ startWatch: jest.fn(() => Promise.resolve()) }),
}));
jest.mock('../backend/src/services/emailSyncService', () => ({
    syncMailbox: (...args) => mockSyncMailbox(...args),
}));
jest.mock('../backend/src/services/onboardingChecklistService', () => ({
    getChecklist: (...args) => mockGetChecklist(...args),
}));

const router = require('../backend/src/routes/email-oauth');

function callbackHandler() {
    const layer = router.stack.find(l => l.route?.path === '/google/callback');
    return layer.route.stack[0].handle;
}

async function runCallback() {
    const res = { redirect: jest.fn() };
    await callbackHandler()({ query: { code: 'auth-code', state: 'signed-state' } }, res);
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
});

test('mid-onboarding connect starts the sync and returns to /welcome', async () => {
    mockGetChecklist.mockResolvedValue({ visible: true });
    const res = await runCallback();
    expect(mockSyncMailbox).toHaveBeenCalledWith('co-1');
    expect(res.redirect).toHaveBeenCalledWith('/welcome?connected=google-email');
});

test('a finished company lands on the settings page, sync still auto-starts', async () => {
    mockGetChecklist.mockResolvedValue({ visible: false });
    const res = await runCallback();
    expect(mockSyncMailbox).toHaveBeenCalledWith('co-1');
    expect(res.redirect).toHaveBeenCalledWith('/settings/integrations/google-email?connected=1');
});

test('a checklist failure keeps the settings redirect (fail-quiet)', async () => {
    mockGetChecklist.mockRejectedValue(new Error('checklist exploded'));
    const res = await runCallback();
    expect(res.redirect).toHaveBeenCalledWith('/settings/integrations/google-email?connected=1');
});

test('a failing initial sync never breaks the OAuth redirect', async () => {
    mockGetChecklist.mockResolvedValue({ visible: true });
    mockSyncMailbox.mockRejectedValueOnce(new Error('gmail down'));
    const res = await runCallback();
    expect(res.redirect).toHaveBeenCalledWith('/welcome?connected=google-email');
});

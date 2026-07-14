'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RATE_PAGE_PATH = 'frontend/src/pages/RatePage.tsx';
const APP_PATH = 'frontend/src/App.tsx';
const AUTH_PROVIDER_PATH = 'frontend/src/auth/AuthProvider.tsx';
const APP_LAYOUT_PATH = 'frontend/src/components/layout/AppLayout.tsx';
const API_CLIENT_PATH = 'frontend/src/services/apiClient.ts';
const REALTIME_PATH = 'frontend/src/hooks/useRealtimeEvents.ts';
const SERVER_PATH = 'src/server.js';
const MARKETPLACE_ROUTE_PATH = 'backend/src/routes/marketplace.js';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function collapse(source) {
    return source.replace(/\s+/g, ' ').trim();
}

function between(source, start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    if (startIndex < 0 || endIndex < 0) {
        throw new Error(`Could not slice source between ${start} and ${end}`);
    }
    return source.slice(startIndex, endIndex);
}

const GOOGLE_PROMPT_REPLICA = ['Punctuality', 'Clear explanation', 'Tidy work', 'Fair price', 'Friendliness'];
const FEEDBACK_PROMPT_REPLICA = ['Timing', 'Communication', 'The repair', 'Pricing'];

describe('RATE-ME-CRM-002 seven-screen public RatePage structural contracts', () => {
    test('TC-RM2-SR-01 · page-state machine follows the GET and POST branch table', () => {
        const source = read(RATE_PAGE_PATH);
        const contextSource = between(source, 'interface RateContext', 'interface RatingResult');
        const pageStateSource = between(source, 'type PageState', 'const STAR_VALUES');
        const loadSource = between(source, 'export default function RatePage()', 'const submitRating');
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');
        const selectSource = between(source, 'const handleStarSelect', 'const handleSend');
        const contextKeys = [...contextSource.matchAll(/^\s{4}([a-z_]+)\??:/gm)].map(match => match[1]);
        const loadReplica = (status, data, networkError = false) => {
            if (networkError) return 'load-error';
            if (status === 404) return 'invalid';
            if (data.expired === true) return 'expired';
            if (data.already_rated === true) return 'already-rated';
            return 'invitation';
        };
        const postReplica = (stars, data) => {
            if (data.already_recorded) return 'already-rated';
            if (stars === 5 && data.next === 'google_redirect' && data.redirect_url) return 'google-helper';
            if (data.next === 'thanks') return stars === 5 ? 'happy' : 'feedback-thanks';
            return 'error';
        };

        expect(contextKeys).toEqual([
            'company_name', 'company_logo_url', 'technician_name', 'first_name',
            'service_label', 'visit_date', 'company_phone', 'company_email',
            'booking_url', 'five_star_redirect', 'already_rated', 'expired',
        ]);
        [
            'loading', 'invitation', 'google-helper', 'happy', 'feedback',
            'feedback-thanks', 'already-rated', 'expired', 'invalid', 'load-error',
        ].forEach(state => expect(pageStateSource).toContain("'" + state + "'"));
        expect(loadSource).toContain('if (response.status === 404)');
        expect(loadSource).toContain('if (payload.data.expired === true)');
        expect(loadSource).toContain("setPageState('expired')");
        expect(loadSource).toContain("setPageState('already-rated')");
        expect(loadSource).toContain("setPageState('invitation')");
        expect(selectSource).toContain('if (stars === 5)');
        expect(selectSource).toContain('void submitRating(5);');
        expect(selectSource).toContain("setPageState('feedback')");
        expect(selectSource.match(/submitRating\(/g)).toHaveLength(1);
        expect(submitSource).toContain("setPageState('google-helper')");
        expect(submitSource).toContain("setPageState(stars === 5 ? 'happy' : 'feedback-thanks')");
        expect(submitSource).toContain("setPageState('already-rated')");
        expect(submitSource).toContain('if (submitLock.current) return;');
        expect(submitSource).toContain('submitLock.current = true;');
        expect(submitSource).toContain('submitLock.current = false;');
        expect(loadReplica(404, {})).toBe('invalid');
        expect(loadReplica(200, { expired: true })).toBe('expired');
        expect(loadReplica(200, { expired: false, already_rated: true })).toBe('already-rated');
        expect(loadReplica(200, { expired: false, already_rated: false })).toBe('invitation');
        expect(loadReplica(0, {}, true)).toBe('load-error');
        expect(postReplica(5, { next: 'google_redirect', redirect_url: 'https://reviews.example/x' })).toBe('google-helper');
        expect(postReplica(5, { next: 'thanks' })).toBe('happy');
        expect(postReplica(3, { next: 'thanks' })).toBe('feedback-thanks');
        expect(postReplica(2, { already_recorded: true, next: 'thanks' })).toBe('already-rated');

        // Manual: walk 5★ with/without Google, 3★, replay, already-rated, expired, 404, and network-error paths.
    });

    test('TC-RM2-SR-02 · Screen 1 personalizes copy and uses accessible gold stars', () => {
        const source = read(RATE_PAGE_PATH);
        const invitationSource = between(source, 'function InvitationView', 'function GoogleHelperView');
        const compact = collapse(source);
        const greetingReplica = firstName => firstName ? 'Hi ' + firstName + ',' : 'Hi there,';
        const summaryReplica = (service, date) => [service, date].filter(Boolean).join(' · ');

        expect(invitationSource).toContain("context.first_name ? `Hi ${context.first_name},` : 'Hi there,'");
        expect(invitationSource).toContain("context.technician_name || 'our technician'");
        expect(invitationSource).toContain("[context.service_label, context.visit_date].filter(Boolean).join(' · ')");
        expect(invitationSource).toContain('<BrandHeader context={context} />');
        expect(invitationSource).toContain('<StarPicker');
        expect(invitationSource).toContain('Tap a star to rate');
        expect(invitationSource).not.toMatch(/ContactLinks|RebookingBlock|booking_url|Book Visit/);
        expect(source).toMatch(/minWidth: 44,[\s\S]*minHeight: 44,/);
        expect(source).toContain("const STAR_FILLED_COLOR = '#E0A72C';");
        expect(source).toContain("const STAR_EMPTY_COLOR = '#D2D2D0';");
        expect(source.match(/fetch\(endpoint\)/g)).toHaveLength(1);
        expect(compact).toContain('{context.company_logo_url && !logoFailed && ( <img');
        expect(source).toContain('onError={() => setLogoFailed(true)}');
        expect(source).toContain('[context.company_logo_url]');
        expect(greetingReplica('Sarah')).toBe('Hi Sarah,');
        expect(greetingReplica(null)).toBe('Hi there,');
        expect(summaryReplica('Refrigerator repair', null)).toBe('Refrigerator repair');
        expect(summaryReplica(null, 'Friday, Jul 12')).toBe('Friday, Jul 12');
        expect(summaryReplica(null, null)).toBe('');

        // Manual: at 375px verify one-handed stars, fallbacks, logo failure, and omitted subline parts.
    });

    test('TC-RM2-SR-03 · Screen 2 is reached only from a 5-star google_redirect result', () => {
        const source = read(RATE_PAGE_PATH);
        const contextSource = between(source, 'interface RateContext', 'interface RatingResult');
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');
        const renderSource = source.slice(source.indexOf('if (!context) return null;'));
        const outcomeReplica = data => data.next === 'google_redirect' && data.redirect_url ? 'google-helper' : 'happy';

        expect(contextSource).toContain('five_star_redirect?: boolean;');
        expect(submitSource).toContain("stars === 5 && payload.data.next === 'google_redirect' && payload.data.redirect_url");
        expect(submitSource).toContain('setRedirectUrl(payload.data.redirect_url);');
        expect(submitSource).toContain("setPageState('google-helper');");
        expect(submitSource).toContain("if (payload.data.next === 'thanks')");
        expect(submitSource).toContain("setPageState(stars === 5 ? 'happy' : 'feedback-thanks')");
        expect(renderSource).toContain("if (pageState === 'google-helper')");
        expect(renderSource.match(/<GoogleHelperView/g)).toHaveLength(1);
        expect(outcomeReplica({ next: 'google_redirect', redirect_url: 'https://reviews.example/x' })).toBe('google-helper');
        expect(outcomeReplica({ next: 'thanks' })).toBe('happy');

        // Manual: a company without a Google URL must go straight from 5★ to the happy thank-you.
    });

    test('TC-RM2-SR-04 · Screen 2 beacons, opens a new tab, then shows happy', () => {
        const source = read(RATE_PAGE_PATH);
        const handlerSource = between(source, 'const handleGoogleReview', "if (pageState === 'loading')");
        const order = [
            handlerSource.indexOf('fetch('),
            handlerSource.indexOf('window.open('),
            handlerSource.indexOf("setPageState('happy')"),
        ];
        const actions = [];
        const replica = () => {
            actions.push('beacon');
            actions.push(['open', 'https://reviews.example/x', '_blank', 'noopener']);
            actions.push('happy');
        };

        expect(handlerSource).toMatch(/fetch\(`\$\{endpoint\}\/click`, \{ method: 'POST', keepalive: true \}\)\.catch\(\(\) => \{\}\);/);
        expect(handlerSource).toContain("window.open(redirectUrl, '_blank', 'noopener');");
        expect(handlerSource).toContain("setPageState('happy');");
        expect(handlerSource).not.toMatch(/submitRating|\/rating/);
        expect(order[0]).toBeGreaterThanOrEqual(0);
        expect(order[0]).toBeLessThan(order[1]);
        expect(order[1]).toBeLessThan(order[2]);
        expect(source).not.toMatch(/window\.location\.replace|location\.href\s*=|useNavigate|navigate\(/);
        replica();
        expect(actions).toEqual([
            'beacon',
            ['open', 'https://reviews.example/x', '_blank', 'noopener'],
            'happy',
        ]);

        // Manual: Google opens in a NEW tab while the happy screen remains in the original tab.
    });

    test('TC-RM2-SR-05 · Screen 3 has personalized thanks, quiet rebooking, and gated contacts', () => {
        const source = read(RATE_PAGE_PATH);
        const happySource = between(source, 'function HappyView', 'interface FeedbackViewProps');
        const signatureSource = between(source, 'function happySignature', 'function HappyView');
        const contactsSource = between(source, 'function ContactLinks', 'function RebookingBlock');
        const quietLinkStyle = between(source, '    quietLink: {', '\n    },');
        const headingReplica = firstName => "You're the best" + (firstName ? ', ' + firstName : '') + '.';

        expect(happySource).toContain("You're the best{context.first_name ? `, ${context.first_name}` : ''}.");
        expect(happySource).toContain("Thanks for supporting a local team. We're here whenever an appliance acts up.");
        expect(signatureSource).toContain('context.technician_name');
        expect(signatureSource).toContain('context.company_name');
        expect(happySource).toContain('{context.booking_url && (');
        expect(happySource).toContain('href={context.booking_url}');
        expect(happySource).toContain('Book your next visit →');
        expect(happySource).toContain('<ContactLinks context={context} />');
        expect(happySource).not.toMatch(/primaryButton|primaryLink|Book Visit/);
        expect(quietLinkStyle).toContain("color: 'var(--blanc-accent)'");
        expect(contactsSource).toContain('if (!context.company_phone && !context.company_email) return null;');
        expect(contactsSource).toContain('{context.company_phone && (');
        expect(contactsSource).toContain('{context.company_email && (');
        expect(headingReplica('Sarah')).toBe("You're the best, Sarah.");
        expect(headingReplica(null)).toBe("You're the best.");

        // Manual: null each personalization/contact field independently; no dead or awkward row remains.
    });

    test('TC-RM2-SR-06 · Screen 4 keeps 1–4 stars private until Send', () => {
        const source = read(RATE_PAGE_PATH);
        const feedbackSource = between(source, 'function FeedbackView', 'function FeedbackThanksView');
        const selectSource = between(source, 'const handleStarSelect', 'const handleSend');
        const sendSource = between(source, 'const handleSend', 'const handleGoogleReview');
        const bodyReplica = (stars, feedback) => ({ stars, feedback });

        expect(selectSource).toContain('setSelectedStars(stars);');
        expect(selectSource).toContain('if (stars === 5)');
        expect(selectSource).toContain("setPageState('feedback');");
        expect(selectSource.match(/submitRating\(/g)).toHaveLength(1);
        expect(feedbackSource).toContain('<StarPicker');
        expect(feedbackSource).toContain('compact onSelect={onSelect}');
        expect(feedbackSource).toContain('Thanks for being straight with us.');
        expect(feedbackSource).toContain("won't be posted publicly");
        expect(feedbackSource).toContain('<textarea');
        expect(feedbackSource).toContain('placeholder="What could we have done better?"');
        expect(source).toContain("const FEEDBACK_PROMPTS = ['Timing', 'Communication', 'The repair', 'Pricing'];");
        expect(feedbackSource).toContain('Private — only {context.company_name} sees this');
        expect(feedbackSource).toContain('Send to the team');
        expect(feedbackSource).not.toMatch(/ContactLinks|RebookingBlock|booking_url/);
        expect(sendSource).toContain('submitRating(selectedStars, feedback);');
        expect(source).not.toMatch(/disabled=\{!feedback|feedback\.trim\(\)/);
        expect(bodyReplica(2, '')).toEqual({ stars: 2, feedback: '' });

        // Manual: choose 3 then 2 and Send empty feedback; only Send may POST stars=2.
    });

    test('TC-RM2-SR-07 · Screen 5 offers contacts without rebooking', () => {
        const source = read(RATE_PAGE_PATH);
        const viewSource = between(source, 'function FeedbackThanksView', 'function alreadyRatedMessage');
        const successStyle = between(source, '    successMark: {', '\n    },');

        expect(viewSource).toContain('Thank you — we hear you.');
        expect(viewSource).toContain('A manager from {context.company_name} will reach out to make this right.');
        expect(viewSource).toContain('Prefer to talk now?');
        expect(viewSource).toContain('<ContactLinks context={context} />');
        expect(viewSource).not.toMatch(/booking_url|RebookingBlock|Book Visit|primaryLink/);
        expect(successStyle).toContain("color: 'var(--blanc-success)'");

        // Manual: a 2★ path ends on contacts-only recovery copy with no booking action.
    });

    test('TC-RM2-SR-08 · Screen 6 handles GET and POST replays with rebooking, not stars', () => {
        const source = read(RATE_PAGE_PATH);
        const viewSource = between(source, 'function alreadyRatedMessage', 'function ExpiredView');
        const rebookingSource = between(source, 'function RebookingBlock', 'interface InvitationViewProps');
        const loadSource = between(source, 'export default function RatePage()', 'const submitRating');
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');

        expect(loadSource).toContain("setPageState('already-rated')");
        expect(submitSource).toContain('if (payload.data.already_recorded)');
        expect(submitSource).toContain("setPageState('already-rated')");
        expect(viewSource).toContain("You've already rated this visit.");
        expect(viewSource).toContain('Thanks again');
        expect(viewSource).toContain('context.first_name');
        expect(viewSource).toContain('context.technician_name');
        expect(viewSource).toContain('<RebookingBlock context={context} />');
        expect(viewSource).not.toContain('<StarPicker');
        expect(rebookingSource).toContain('Need help again?');
        expect(rebookingSource).toContain('Book your next service anytime');
        expect(rebookingSource).toContain('{context.booking_url && (');
        expect(rebookingSource).toContain('Book Visit');
        expect(rebookingSource).toContain('<ContactLinks context={context} />');

        // Manual: GET already-rated and stale-tab POST replay both show Screen 6 with no picker.
    });

    test('TC-RM2-SR-09 · Screen 7 is branded-expired while 404 stays generic', () => {
        const source = read(RATE_PAGE_PATH);
        const expiredSource = between(source, 'function ExpiredView', 'export default function RatePage');
        const loadSource = between(source, 'export default function RatePage()', 'const submitRating');
        const invalidSource = between(source, "if (pageState === 'invalid')", "if (pageState === 'load-error')");
        const loadErrorSource = between(source, "if (pageState === 'load-error')", 'if (!context) return null;');

        expect(loadSource).toContain('if (response.status === 404)');
        expect(loadSource).toContain("setPageState('invalid')");
        expect(loadSource).toContain('if (payload.data.expired === true)');
        expect(loadSource.indexOf('payload.data.expired')).toBeLessThan(loadSource.indexOf('payload.data.already_rated'));
        expect(expiredSource).toContain('This link has expired.');
        expect(expiredSource).toContain('Rating links stay active for a while after your visit.');
        expect(expiredSource).toContain('<RebookingBlock context={context} />');
        expect(expiredSource).toContain('styles.clockMark');
        expect(invalidSource).toContain('This link is no longer available.');
        expect(invalidSource).not.toMatch(/context|BrandHeader|RebookingBlock|ContactLinks|booking_url|company_name/);
        expect(loadErrorSource).toContain('{TRANSIENT_ERROR}');
        expect(loadErrorSource).toContain('Try again');
        expect(loadErrorSource).toContain('setReloadKey(value => value + 1)');

        // Manual: expired recognized links rebook; random/foreign tokens show only the generic line.
    });

    test('TC-RM2-SR-10 · prompt chips on Screens 2 and 4 cannot insert text', () => {
        const source = read(RATE_PAGE_PATH);
        const chipSource = between(source, 'function PromptChips', 'function ContactLinks');
        const googleSource = between(source, 'function GoogleHelperView', 'function happySignature');
        const feedbackSource = between(source, 'function FeedbackView', 'function FeedbackThanksView');
        const textareaValue = 'Customer-written text';
        const inertClick = () => undefined;

        expect(source).toContain("const GOOGLE_PROMPTS = ['Punctuality', 'Clear explanation', 'Tidy work', 'Fair price', 'Friendliness'];");
        expect(source).toContain("const FEEDBACK_PROMPTS = ['Timing', 'Communication', 'The repair', 'Pricing'];");
        expect(chipSource).toContain('<button key={label} type="button" style={styles.chip}>');
        expect(chipSource).not.toMatch(/onClick|setFeedback|onFeedbackChange|onChange|concat|label\s*\+/);
        expect(googleSource).toContain('<PromptChips labels={GOOGLE_PROMPTS} />');
        expect(googleSource).toContain('Just prompts — your own words matter most.');
        expect(feedbackSource).toContain('<PromptChips labels={FEEDBACK_PROMPTS} />');
        expect(source.match(/<PromptChips/g)).toHaveLength(2);
        [...GOOGLE_PROMPT_REPLICA, ...FEEDBACK_PROMPT_REPLICA].forEach(inertClick);
        expect(textareaValue).toBe('Customer-written text');

        // Manual: click every chip on both screens; typed feedback remains byte-for-byte unchanged.
    });

    test('TC-RM2-SR-11 · stars are gold and all real actions use violet tokens', () => {
        const source = read(RATE_PAGE_PATH);
        const hexValues = source.match(/#[0-9a-fA-F]{6}\b/g) || [];
        const actionStyleNames = ['primaryButton', 'ghostButton', 'quietLink', 'contactLink', 'primaryLink'];

        expect([...new Set(hexValues)].sort()).toEqual(['#D2D2D0', '#E0A72C']);
        expect(source).toContain('color: active ? STAR_FILLED_COLOR : STAR_EMPTY_COLOR');
        actionStyleNames.forEach(styleName => {
            const styleSource = between(source, '    ' + styleName + ': {', '\n    },');
            expect(styleSource).toContain('var(--blanc-accent)');
        });
        ['Write my Google review', 'Send to the team', 'Book Visit', 'Book your next visit →']
            .forEach(label => expect(source).toContain(label));
        expect(source).not.toMatch(/Blanc/);
        expect(source).toContain("'IBM Plex Sans'");
        expect(source).toContain("'Manrope'");

        // Manual: light/dark screens show gold stars and violet actions, with no rendered legacy name.
    });

    test('TC-RM2-SR-12 · booking and contacts obey the seven-screen placement matrix', () => {
        const source = read(RATE_PAGE_PATH);
        const invitationSource = between(source, 'function InvitationView', 'function GoogleHelperView');
        const googleSource = between(source, 'function GoogleHelperView', 'function happySignature');
        const happySource = between(source, 'function HappyView', 'interface FeedbackViewProps');
        const feedbackSource = between(source, 'function FeedbackView', 'function FeedbackThanksView');
        const feedbackThanksSource = between(source, 'function FeedbackThanksView', 'function alreadyRatedMessage');
        const alreadySource = between(source, 'function AlreadyRatedView', 'function ExpiredView');
        const expiredSource = between(source, 'function ExpiredView', 'export default function RatePage');
        const rebookingSource = between(source, 'function RebookingBlock', 'interface InvitationViewProps');
        const contactsSource = between(source, 'function ContactLinks', 'function RebookingBlock');

        [invitationSource, googleSource, feedbackSource].forEach(screen => {
            expect(screen).not.toMatch(/ContactLinks|RebookingBlock|booking_url|Book Visit/);
        });
        expect(happySource).toContain('{context.booking_url && (');
        expect(happySource).toContain('Book your next visit →');
        expect(happySource).toContain('<ContactLinks context={context} />');
        expect(feedbackThanksSource).toContain('<ContactLinks context={context} />');
        expect(feedbackThanksSource).not.toMatch(/booking_url|RebookingBlock|Book Visit/);
        expect(alreadySource).toContain('<RebookingBlock context={context} />');
        expect(expiredSource).toContain('<RebookingBlock context={context} />');
        expect(rebookingSource).toContain('{context.booking_url && (');
        expect(rebookingSource).toContain('<ContactLinks context={context} />');
        expect(contactsSource).toContain('{context.company_phone && (');
        expect(contactsSource).toContain('{context.company_email && (');

        // Manual: sweep all screens with each URL/contact null; no dead affordance or empty row renders.
    });

    test('TC-RM2-SR-13 · SPA bypass and CRM-free raw-fetch boundaries remain pinned', () => {
        const source = read(RATE_PAGE_PATH);
        const imports = source.match(/^import .*;$/gm)?.join('\n') || '';
        const appSource = read(APP_PATH);
        const appCompact = collapse(appSource);
        const authSource = read(AUTH_PROVIDER_PATH);
        const layoutSource = read(APP_LAYOUT_PATH);
        const protectedSources = read(API_CLIENT_PATH) + '\n' + read(REALTIME_PATH);

        expect(source).toContain('const response = await fetch(endpoint);');
        expect(source).toMatch(/fetch\(`\$\{endpoint\}\/rating`/);
        expect(source).toMatch(/fetch\(`\$\{endpoint\}\/click`/);
        expect(source).not.toContain('authedFetch');
        expect(imports).not.toMatch(/components\/|hooks\/useRealtimeEvents|@tanstack\/react-query|sonner/);
        expect(appCompact).toContain('<Route path="/e/:token" element={<PublicEstimateViewPage />} /> <Route path="/r/:token" element={<RatePage />} />');
        expect(appSource).not.toMatch(/path=["']\*["']/);
        expect(authSource).toContain("const PUBLIC_AUTH_PATHS = ['/signup', '/pay', '/e', '/r/'];");
        expect(authSource).not.toContain("'/r']");
        expect(layoutSource).toContain("location.pathname.startsWith('/r/')");
        expect(protectedSources).not.toMatch(/rate-me|RateMe|\/r\//);

        // Manual: direct-load /r/<token>; expect no Keycloak redirect, CRM chrome, React Query, or SSE.
    });
});

describe('RATE-ME-CRM-001 inherited auth and server mount contracts', () => {
    test('TC-S8-02 · secured marketplace mount and two flagged server additions stay pinned', () => {
        const serverSource = read(SERVER_PATH);
        const serverCompact = collapse(serverSource);
        const routerSource = read(MARKETPLACE_ROUTE_PATH);
        const helper = routerSource.match(/function companyId\(req\)\s*\{[\s\S]*?\n\}/);
        const rateBlock = between(
            routerSource,
            "router.put('/apps/rate-me/domain'",
            "router.post('/apps/:appKey/install'"
        );

        expect(serverCompact).toMatch(/app\.use\('\/api\/marketplace', authenticate, requirePermission\('tenant\.integrations\.manage'\), requireCompanyAccess, marketplaceRouter\);/);
        expect(serverSource.match(/RATE-ME-CRM-001/g)).toHaveLength(2);
        expect(serverSource).toContain("app.use(require('../backend/src/middleware/rateHostGate'));");
        expect(serverSource).toContain("app.use('/api/public', publicRateRouter);");
        expect(serverSource.indexOf("app.use(require('../backend/src/middleware/rateHostGate'));")).toBeLessThan(serverSource.indexOf("app.use('/api/billing/webhook'"));
        expect(serverSource.indexOf("app.use('/api/public', publicRateRouter);")).toBeLessThan(serverSource.indexOf("app.use('/api/marketplace'"));

        expect(helper).not.toBeNull();
        expect(helper[0]).toContain('req.companyFilter?.company_id');
        expect(routerSource.replace(helper[0], '')).not.toMatch(/company_id/);
        expect(rateBlock.match(/companyId\(req\)/g)).toHaveLength(4);
        expect(rateBlock).not.toMatch(/req\.companyId|req\.(?:params|body|query)(?:\.|\?\.)company_id/);
    });
});

const RATE_SETTINGS_DIALOG_PATH = 'frontend/src/pages/RateMeSettingsDialog.tsx';
const MARKETPLACE_API_PATH = 'frontend/src/services/marketplaceApi.ts';
const INTEGRATIONS_PAGE_PATH = 'frontend/src/pages/IntegrationsPage.tsx';
const CADDYFILE_PATH = 'infra/Caddyfile';
const INFRA_README_PATH = 'infra/README.md';

describe('RATE-ME-CRM-001 settings dialog structural contracts', () => {
    test('TC-D19-01 · domain pane renders the literal CNAME record and humane statuses', () => {
        const source = read(RATE_SETTINGS_DIALOG_PATH);
        const compact = collapse(source);
        const firstLabel = value => value.trim().split('.')[0] || 'rate';

        expect(source).toContain("const firstLabel = domainInput.trim().split('.')[0] || 'rate';");
        expect(source).toContain("const publicHost = settingsQuery.data?.public_host || '';");
        expect(source).toContain('<div>Type: CNAME</div>');
        expect(source).toContain('<div>Host/Name: {firstLabel}</div>');
        expect(source).toContain('<div>Target: {publicHost}</div>');
        expect(compact).toContain('{firstLabel} IN CNAME {publicHost}');
        expect(source).toContain("return 'Waiting for DNS';");
        expect(source).toContain("return 'Verified';");
        expect(source).toContain('return `Live at https://${domain.domain}`;');
        expect(source).toContain('{domain.last_error}');
        expect(source).toContain("domain.status === 'failed' ? 'Retry' : 'Verify'");
        expect(source).toContain("removeDomainMutation.isPending ? 'Removing…' : 'Remove'");

        expect(firstLabel('rate.bostonmasters.com')).toBe('rate');
        expect(firstLabel('reviews.acme.co')).toBe('reviews');
        expect(`Type: CNAME · Host/Name: ${firstLabel('rate.bostonmasters.com')} · Target: rate.albusto.com`)
            .toBe('Type: CNAME · Host/Name: rate · Target: rate.albusto.com');

        // Manual: enter reviews.acme.co, then confirm the failed copy and Retry affordance after a failed check.
    });

    test('TC-S9-01 · hosting mode derives from GET data and only explicit actions mutate domains', () => {
        const source = read(RATE_SETTINGS_DIALOG_PATH);
        const albustoRadio = between(source, 'value="albusto"', 'className="mt-0.5 h-4 w-4');
        const customRadio = between(source, 'value="custom"', 'className="mt-0.5 h-4 w-4');
        const saveHandler = between(source, 'const handleSave = () => {', 'const handleSaveDomain');

        expect(source).toContain('const customHosting = domain !== null || customDraftOpen;');
        expect(source).not.toMatch(/hostingMode[^\n]*useState|useState[^\n]*hostingMode/);
        expect(albustoRadio).toContain('checked={!customHosting}');
        expect(albustoRadio).toContain('setCustomDraftOpen(false)');
        expect(customRadio).toContain('checked={customHosting}');
        expect(customRadio).toContain('setCustomDraftOpen(true)');
        expect(`${albustoRadio}\n${customRadio}`).not.toMatch(/setRateMeDomain|verifyRateMeDomain|removeRateMeDomain|\.mutate\(/);
        expect(saveHandler).toContain('saveMutation.mutate({ google_review_url: googleReviewUrl.trim() || null });');
        expect(saveHandler).not.toMatch(/Domain|domain/);
        expect(source).toContain('mutationFn: removeRateMeDomain');
        expect(source).toContain('onClick={() => removeDomainMutation.mutate()}');
        expect(source).toContain("queryKey: ['rate-me-settings']");
        expect(source).toContain('enabled: open');
        expect(source).toContain("setDomainInput(settingsQuery.data.domain?.domain || '');");
        expect(source).toContain('setCustomDraftOpen(false);');

        // Manual: flip both radios with Network open; only Save domain, Verify, Remove, and footer Save may request.
    });

    test('TC-S9-02 · FORM-CANON, API exports, invalidation, and connected-only tile gate are pinned', () => {
        const dialogSource = read(RATE_SETTINGS_DIALOG_PATH);
        const apiSource = read(MARKETPLACE_API_PATH);
        const integrationsSource = read(INTEGRATIONS_PAGE_PATH);
        const integrationsCompact = collapse(integrationsSource);
        const newFrontendSources = `${dialogSource}\n${apiSource}`;

        expect(dialogSource).toContain('<DialogContent variant="panel">');
        expect(dialogSource).toContain('<DialogPanelHeader>');
        expect(dialogSource).toContain('<DialogBody className="md:px-8 md:py-7">');
        expect(dialogSource).toContain('className="mx-auto w-full max-w-[740px] space-y-6"');
        expect(dialogSource).toContain('<DialogPanelFooter>');
        expect(dialogSource).toContain('<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>');
        expect(dialogSource).toContain("{saveMutation.isPending ? 'Saving…' : 'Save'}");
        expect(dialogSource).toContain('label="Google review link"');
        expect(dialogSource).toContain('label="Your subdomain"');
        expect(dialogSource).not.toContain('variant="dialog"');
        expect(dialogSource).not.toContain('aria-label="Close"');

        expect(apiSource).toContain("import { authedFetch } from './apiClient';");
        expect(apiSource).toContain('export interface RateMeDomain');
        expect(apiSource).toContain('export interface RateMeSettingsResponse');
        expect(apiSource).toContain('google_review_url: string | null;');
        expect(apiSource).toContain('domain: RateMeDomain | null;');
        expect(apiSource).toContain('public_host: string;');
        expect(apiSource).toContain('export async function fetchRateMeSettings');
        expect(apiSource).toContain('export async function saveRateMeSettings');
        expect(apiSource).toContain('export async function setRateMeDomain');
        expect(apiSource).toContain('export async function verifyRateMeDomain');
        expect(apiSource).toContain('export async function removeRateMeDomain');
        expect(dialogSource.match(/invalidateQueries\(\{ queryKey: \['rate-me-settings'\] \}\)/g)).toHaveLength(4);
        expect(dialogSource.match(/toast\.error\(error\.message/g)).toHaveLength(4);

        expect(integrationsCompact).toContain("app.app_key === 'rate-me' && app.installation?.status === 'connected' && ( <Button variant=\"outline\" size=\"sm\" onClick={() => setRateMeSettingsOpen(true)}> Settings </Button> )");
        expect(integrationsSource).toContain('<RateMeSettingsDialog open={rateMeSettingsOpen} onOpenChange={setRateMeSettingsOpen} />');
        expect(newFrontendSources).not.toMatch(/Blanc/);
        expect(newFrontendSources).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});

describe('RATE-ME-CRM-001 Caddy and deployment reference contracts', () => {
    test('TC-C1-01 · global on-demand TLS ask fragment is exact', () => {
        const caddy = read(CADDYFILE_PATH);

        expect(caddy).toContain(`{
\temail help@bostonmasters.com
\ton_demand_tls {
\t\task http://127.0.0.1:3000/api/public/rate-domain-ask
\t\tinterval 2m
\t\tburst 5
\t}
}`);
        expect(caddy.match(/on_demand_tls \{/g)).toHaveLength(1);
    });

    test('TC-C2-01 · shared rate host uses a managed certificate block', () => {
        const caddy = read(CADDYFILE_PATH);
        const rateHostBlock = between(caddy, 'rate.albusto.com {', '\n}');

        expect(caddy).toContain(`rate.albusto.com {
\tencode zstd gzip
\treverse_proxy 127.0.0.1:3000
}`);
        expect(rateHostBlock).not.toContain('on_demand');
    });

    test('TC-C3-01 · on-demand catch-all is exact and existing site blocks remain verbatim', () => {
        const caddy = read(CADDYFILE_PATH);

        expect(caddy).toContain(`https:// {
\tencode zstd gzip
\ttls {
\t\ton_demand
\t}
\treverse_proxy 127.0.0.1:3000
}`);
        expect(caddy).toContain(`albusto.com, www.albusto.com {
\troot * /var/www/albusto
\tencode zstd gzip
\tfile_server
\theader {
\t\tX-Content-Type-Options nosniff
\t\tReferrer-Policy no-referrer-when-downgrade
\t}
}`);
        expect(caddy).toContain(`app.albusto.com, api.albusto.com {
\tencode zstd gzip

\t# Marketplace apps (isolated runtimes) under /apps/<key>
\thandle_path /apps/leads* {
\t\treverse_proxy 127.0.0.1:4001
\t}

\thandle {
\t\treverse_proxy 127.0.0.1:3000
\t}

\thandle_errors {
\t\trespond "Albusto backend is not deployed yet." {err.status_code}
\t}
}`);
        expect(caddy).toContain(`auth.albusto.com {
\tencode zstd gzip
\t# Bare root otherwise 302s into the raw Keycloak admin console; send
\t# visitors to the app instead (unauthenticated users get the branded login).
\t@root path /
\tredir @root https://app.albusto.com/ 302

\treverse_proxy 127.0.0.1:8081
}`);
    });

    test('TC-C4-01 · README keeps the owner-gated deploy, smoke, and rollback order', () => {
        const readme = read(INFRA_README_PATH);
        const section = readme.slice(readme.indexOf('## Rate Me custom-domain rollout'));
        const orderedSteps = [
            'Deploy the app with migration 177 first',
            'GoDaddy A record `rate → 108.61.87.117`',
            'validate → backup → swap → reload',
            "curl -H 'Host: rate.albusto.com' 127.0.0.1:3000/r/x",
            'restore `Caddyfile.bak.<ts>`',
        ];

        expect(section).toContain('dark deployment');
        expect(section).toContain('browser-only');
        expect(section).toContain('caddy validate');
        expect(section).toContain('sudo cp');
        expect(section).toContain('sudo systemctl reload caddy');
        expect(section).toContain('uniform\n   404');
        expect(section).toContain('POST /api/marketplace/apps/rate-me/tokens');
        expect(section).toContain('https://rate.albusto.com/r/<token>');
        expect(section).toContain('Caddy on the production host is 2.6.2');
        expect(section).toContain('removed in Caddy ≥2.8');
        expect(section).toContain('re-check this fragment before any');
        expect(section).toContain('owner\'s explicit “yes”');
        orderedSteps.forEach((step, index) => {
            expect(section.indexOf(step)).toBeGreaterThan(index === 0 ? -1 : section.indexOf(orderedSteps[index - 1]));
        });
    });
});

// RM2-T7 — APPEND ONLY: T6 owns the harness and TC-RM2-SR-01..13 above.
describe('RATE-ME-CRM-002 Job-card Rate Me structural contract', () => {
    test('TC-RM2-SR-14 · Job-card timeline, send-link panel, and authenticated jobs clients are pinned', () => {
        const blockSource = read('frontend/src/components/jobs/JobRateMeBlock.tsx');
        const modalSource = read('frontend/src/components/jobs/RateLinkModal.tsx');
        const jobStatusSource = read('frontend/src/components/jobs/JobStatusTags.tsx');
        const jobsApiSource = read('frontend/src/services/jobsApi.ts');
        const actionBand = between(jobStatusSource, '{/* ── JOB-ACTIONS-SLIM-001', '{/* ── ONWAY-001: "On the way" modal');

        expect(blockSource).toContain("queryKey: ['job-rate-status', jobId]");
        expect(blockSource).toContain('queryFn: () => getRateStatus(jobId)');
        expect(blockSource).toContain('status.sent_at &&');
        expect(blockSource).toContain('status.opened_at &&');
        expect(blockSource).toContain('status.rating?.created_at &&');
        expect(blockSource).toContain('status.google_click_at &&');
        expect(blockSource).toContain('Rating link sent · via');
        expect(blockSource).toContain('label="Opened"');
        expect(blockSource).toContain('Rated ★');
        expect(blockSource).toContain('label="Opened Google review"');
        expect(blockSource).toContain('Send rating link');
        expect(blockSource).toContain("style={{ backgroundColor: 'var(--blanc-accent)' }}");
        expect(blockSource).toContain('await statusQuery.refetch();');
        expect(blockSource).toContain('onSuccess={refreshAfterSend}');

        expect(modalSource).toContain('<DialogContent variant="panel">');
        expect(modalSource).toContain('<DialogPanelHeader>');
        expect(modalSource).toContain('<DialogBody className="md:px-8 md:py-7">');
        expect(modalSource).toContain('className="mx-auto w-full max-w-[740px] space-y-6"');
        expect(modalSource).toContain('<DialogPanelFooter>');
        expect(modalSource).not.toContain('variant="dialog"');
        expect(modalSource).toContain("setChannel('sms')");
        expect(modalSource).toContain("setChannel('email')");
        expect(modalSource).toContain("setChannel('copy')");
        expect(modalSource).toContain('disabled={!hasPhone || sending}');
        expect(modalSource).toContain('disabled={!hasEmail || sending}');
        expect(modalSource).toContain('No customer phone on file');
        expect(modalSource).toContain('No customer email on file');
        expect(modalSource).toContain('const result = await sendRateLink(jobId, channel);');
        expect(modalSource).toContain('navigator.clipboard.writeText(result.url)');
        expect(modalSource).toContain("toast.success('Rating link copied.')");
        ['WALLET_BLOCKED', 'SMS_FAILED', 'NO_PHONE', 'NO_EMAIL', 'MAIL_DISCONNECTED'].forEach(code => {
            expect(modalSource).toContain(`code === '${code}'`);
        });
        expect(modalSource).toContain('error instanceof RateLinkError');

        expect(actionBand).toContain('<JobRateMeBlock');
        expect(actionBand).toContain('jobId={job.id}');
        expect(actionBand).toContain('customerPhone={job.customer_phone}');
        expect(actionBand).toContain('customerEmail={job.customer_email}');
        expect(actionBand).toContain("canSend={hasPermission('messages.send')}");
        expect(actionBand).toContain('onSent={onNotified}');

        expect(jobsApiSource).toContain("import { authedFetch } from './apiClient';");
        expect(jobsApiSource).toContain('export class RateLinkError extends Error');
        expect(jobsApiSource).toContain('export async function getRateStatus(jobId: number)');
        expect(jobsApiSource).toContain('`${JOBS_BASE}/${jobId}/rate-status`');
        expect(jobsApiSource).toContain('export async function sendRateLink(jobId: number, channel: RateLinkChannel)');
        expect(jobsApiSource).toContain('`${JOBS_BASE}/${jobId}/rate-link`');
        expect(jobsApiSource).toContain("method: 'POST'");
        expect(jobsApiSource).toContain('body: JSON.stringify({ channel })');
        expect(`${blockSource}\n${modalSource}`).not.toMatch(/Blanc/);
        expect(`${blockSource}\n${modalSource}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

        // Manual: open a job, verify reached-only steps, and exercise SMS/Email/Copy plus error toasts.
    });
});

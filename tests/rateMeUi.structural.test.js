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

describe('RATE-ME-CRM-001 public RatePage structural contracts', () => {
    test('TC-U1-01 · happy render canon is CRM-free, mobile-first, and branded', () => {
        const source = read(RATE_PAGE_PATH);
        const imports = source.match(/^import .*;$/gm)?.join('\n') || '';

        expect(source).toContain('const response = await fetch(endpoint);');
        expect(source.match(/fetch\(endpoint\)/g)).toHaveLength(1);
        expect(source).toContain('fetch(`${endpoint}/rating`');
        expect(source).not.toContain('authedFetch');
        expect(imports).not.toMatch(/components\/|hooks\/useRealtimeEvents|@tanstack\/react-query|sonner/);
        expect(source).toContain("'IBM Plex Sans'");
        expect(source).toContain("'Manrope'");
        expect(source).toMatch(/width: 52,[\s\S]*height: 52,/);
        expect(source).toMatch(/minWidth: 44,[\s\S]*minHeight: 44,/);
        expect(source).toContain('<h1 style={styles.heading}>How did {technicianName} do?</h1>');
        expect(source).not.toMatch(/Blanc/);
        expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

        // Manual: open a minted link at 375 px; confirm one-handed stars and no CRM chrome or login UI.
    });

    test('TC-U2-01 · branding has null-logo and failed-image fallbacks', () => {
        const source = read(RATE_PAGE_PATH);
        const compact = collapse(source);

        expect(compact).toContain('{context.company_logo_url && !logoFailed && ( <img');
        expect(source).toContain('onError={() => setLogoFailed(true)}');
        expect(source).toContain('[context.company_logo_url]');
        expect(source.match(/<img/g)).toHaveLength(1);

        // Manual: test both a null logo and a broken presigned URL; both must leave a clean name-only header.
    });

    test('TC-U3-01 · five stars posts immediately, locks submission, and replace-redirects', () => {
        const source = read(RATE_PAGE_PATH);
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');
        const selectSource = between(source, 'const handleStarSelect', 'const handleSend');
        const replaced = [];
        const replica = data => {
            if (data.next === 'google_redirect' && data.redirect_url) {
                replaced.push(data.redirect_url);
                return 'redirect';
            }
            return 'thanks';
        };

        expect(selectSource).toContain('if (stars === 5) void submitRating(5);');
        expect(submitSource).toContain('if (submitLock.current) return;');
        expect(submitSource).toContain('submitLock.current = true;');
        expect(source).toContain('disabled={submitting}');
        expect(submitSource).toContain('window.location.replace(payload.data.redirect_url);');
        expect(source).not.toMatch(/window\.location\.href\s*=|useNavigate|navigate\(/);
        expect(replica({ next: 'google_redirect', redirect_url: 'https://reviews.example/x' })).toBe('redirect');
        expect(replaced).toEqual(['https://reviews.example/x']);

        // Manual: tap 5 stars, verify immediate navigation, then Back must not reopen the consumed picker.
    });

    test('TC-U4-01 · five stars without a review link falls back to thanks', () => {
        const source = read(RATE_PAGE_PATH);
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');
        const outcomeReplica = data => data.next === 'google_redirect' ? 'redirect' : 'thanks';

        expect(submitSource).toContain("payload.data.next === 'thanks'");
        expect(submitSource).toContain("setPageState('thanks')");
        expect(source).toContain('Thanks! Your feedback means a lot to us.');
        expect(outcomeReplica({ next: 'thanks' })).toBe('thanks');

        // Manual: use a company without a Google review link; 5 stars must show thanks without an error.
    });

    test('TC-U5-01 · one to four stars wait for optional feedback and Send', () => {
        const source = read(RATE_PAGE_PATH);
        const selectSource = between(source, 'const handleStarSelect', 'const handleSend');
        const sendSource = between(source, 'const handleSend', "if (pageState === 'loading')");
        let selected = null;
        const selectReplica = stars => { selected = stars; };
        const sendReplica = feedback => ({ stars: selected, feedback });

        expect(selectSource).toContain('setSelectedStars(stars);');
        expect(selectSource.match(/submitRating\(/g)).toHaveLength(1);
        expect(selectSource).toContain('stars === 5');
        expect(source).toContain('selectedStars < 5');
        expect(source).toContain('What could we have done better?');
        expect(source).toContain('<textarea');
        expect(sendSource).toContain('submitRating(selectedStars, selectedStars < 5 ? feedback : undefined)');
        expect(source).not.toMatch(/disabled=\{!feedback|feedback\.trim\(\)/);

        selectReplica(3);
        selectReplica(2);
        expect(sendReplica('')).toEqual({ stars: 2, feedback: '' });

        // Manual: choose 3, change to 2, and Send an empty textarea; only the Send click may POST stars=2.
    });

    test('TC-U6-01 · already-rated context goes directly to the shared thanks view', () => {
        const source = read(RATE_PAGE_PATH);

        expect(source).toContain("setPageState(payload.data.already_rated ? 'thanks' : 'rating')");
        expect(source).toContain("if (pageState === 'thanks') return <ThanksView context={context} />;");
        expect(source.indexOf("if (pageState === 'thanks')")).toBeLessThan(source.indexOf('<StarPicker'));

        // Manual: open an already-rated token and confirm the picker never appears.
    });

    test('TC-U7-01 · replayed POST is success-class and renders thanks', () => {
        const source = read(RATE_PAGE_PATH);
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');

        expect(submitSource).toContain("if (payload.data.already_recorded || payload.data.next === 'thanks')");
        expect(submitSource).toContain("setPageState('thanks')");

        // Manual: submit from a stale second tab after another device rated; it must show thanks, not an error.
    });

    test('TC-U8-01 · POST failures preserve selection and re-enable the same retry path', () => {
        const source = read(RATE_PAGE_PATH);
        const submitSource = between(source, 'const submitRating', 'const handleStarSelect');
        const catchSource = between(submitSource, '} catch {', '} finally {');
        const finallySource = submitSource.slice(submitSource.indexOf('} finally {'));
        const failureReplica = (status, stars) => ({
            error: status >= 400 ? 'Something went wrong — please try again.' : null,
            stars,
            sendDisabled: false,
        });

        expect(submitSource).toContain('if (!response.ok || payload.ok === false || !payload.data)');
        expect(catchSource).toContain('setSubmitError(TRANSIENT_ERROR);');
        expect(catchSource).not.toMatch(/setSelectedStars|setFeedback|location\.replace|setPageState\('thanks'\)/);
        expect(finallySource).toContain('submitLock.current = false;');
        expect(finallySource).toContain('setSubmitting(false);');
        expect(source).toContain("const showSend = showFeedback || (selectedStars === 5 && submitError !== null);");
        expect(failureReplica(429, 5)).toEqual({
            error: 'Something went wrong — please try again.',
            stars: 5,
            sendDisabled: false,
        });
        expect(failureReplica(500, 2).stars).toBe(2);

        // Manual: block or 429 the POST; selection and feedback stay intact and Send becomes usable again.
    });

    test('TC-U9-01 · direct-load invalid and transient errors are distinct', () => {
        const source = read(RATE_PAGE_PATH);
        const loadSource = between(source, 'useEffect(() => {', 'const submitRating');
        const invalidView = between(source, "if (pageState === 'invalid')", "if (pageState === 'load-error')");
        const loadErrorView = between(source, "if (pageState === 'load-error')", 'if (!context) return null;');

        expect(loadSource).toContain('if (response.status === 404)');
        expect(loadSource).toContain("setPageState('invalid')");
        expect(loadSource).toContain("setPageState('load-error')");
        expect(invalidView).toContain('This link is no longer available.');
        expect(invalidView).not.toContain('Try again');
        expect(loadErrorView).toContain('{TRANSIENT_ERROR}');
        expect(loadErrorView).toContain('Try again');
        expect(loadErrorView).toContain('setReloadKey(value => value + 1)');

        // Manual: a 404 has no retry; offline/network failure has Try again and can recover.
    });

    test('TC-U10-01 · technician name has the required human fallback', () => {
        const source = read(RATE_PAGE_PATH);
        const headingReplica = name => `How did ${name || 'our technician'} do?`;

        expect(source).toContain("const technicianName = context.technician_name || 'our technician';");
        expect(headingReplica('Alex Petrov')).toBe('How did Alex Petrov do?');
        expect(headingReplica(null)).toBe('How did our technician do?');

        // Manual: compare named and null-technician tokens; both headings must read naturally.
    });

    test('TC-U11-01 · SPA route, auth bypass, and bare-layout pins are exact', () => {
        const appSource = read(APP_PATH);
        const appCompact = collapse(appSource);
        const authSource = read(AUTH_PROVIDER_PATH);
        const layoutSource = read(APP_LAYOUT_PATH);
        const protectedSources = `${read(API_CLIENT_PATH)}\n${read(REALTIME_PATH)}`;

        expect(appCompact).toContain('<Route path="/e/:token" element={<PublicEstimateViewPage />} /> <Route path="/r/:token" element={<RatePage />} />');
        expect(appSource).not.toMatch(/path=["']\*["']/);
        expect(authSource).toContain("const PUBLIC_AUTH_PATHS = ['/signup', '/pay', '/e', '/r/'];");
        expect(authSource).not.toContain("'/r']");
        expect(layoutSource).toContain("location.pathname.startsWith('/r/')");
        expect(protectedSources).not.toMatch(/rate-me|RateMe|\/r\//);

        // Manual: direct-load /r/<token> on an app host; expect no Keycloak redirect or CRM chrome.
        // Manual empty-token edge: /r/ stays a blank bare page because there is no catch-all route.
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
            'Deploy the app with migration 172 first',
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

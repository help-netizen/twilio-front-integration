'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INTEGRATIONS_PATH = path.join(ROOT, 'frontend/src/pages/IntegrationsPage.tsx');
const DIALOG_PATH = path.join(ROOT, 'frontend/src/pages/RelyLeadsSettingsDialog.tsx');
const API_PATH = path.join(ROOT, 'frontend/src/services/marketplaceApi.ts');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function collapse(source) {
    return source.replace(/\s+/g, ' ').trim();
}

function readFilesRecursively(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory() ? readFilesRecursively(fullPath) : [fullPath];
    });
}

describe('RELY-LEADS-SETTINGS-001 frontend structural contracts', () => {
    test('TC-U1-01 · Settings button is gated to a connected rely-leads installation', () => {
        const source = fs.readFileSync(INTEGRATIONS_PATH, 'utf8');
        const compact = collapse(source);
        const gate = "app.app_key === 'rely-leads' && app.installation?.status === 'connected'";

        expect(compact.match(/app\.app_key === 'rely-leads'/g)).toHaveLength(1);
        expect(compact).toContain(gate);
        expect(compact).toMatch(/app\.app_key === 'rely-leads' && app\.installation\?\.status === 'connected' && \( <Button variant="outline" size="sm" onClick=\{\(\) => setRelySettingsOpen\(true\)\}> Settings <\/Button> \)/);
        expect(compact.indexOf(gate)).toBeLessThan(compact.indexOf('Disconnect', compact.indexOf(gate)));
        expect(compact).not.toMatch(/status === 'provisioning_failed' && \( <Button[^>]*> Settings <\/Button>/);

        const frontendSource = readFilesRecursively(path.join(ROOT, 'frontend/src'))
            .map(filename => fs.readFileSync(filename, 'utf8'))
            .join('\n');
        expect(frontendSource).not.toMatch(/pro-referral-leads|nsa-leads|lhg-leads|lead-generator/);
    });

    test('TC-U2-01 · settings surface follows the panel form canon', () => {
        const source = fs.readFileSync(DIALOG_PATH, 'utf8');
        const compact = collapse(source);
        const newFrontendSource = `${source}\n${fs.readFileSync(API_PATH, 'utf8')}`;

        for (const marker of [
            'variant="panel"',
            'DialogPanelHeader',
            'Rely Leads settings',
            'DialogBody',
            'md:px-8 md:py-7',
            'max-w-[740px]',
            'space-y-6',
            'DialogPanelFooter',
        ]) {
            expect(source).toContain(marker);
        }
        expect(compact).toMatch(/<Button type="button" variant="ghost".*?>Cancel<\/Button>/);
        expect(compact).toMatch(/<Button type="button" onClick=\{handleSave\}[^>]*> .*'Save'.* <\/Button>/);
        expect(source).toContain("queryKey: ['rely-leads-settings']");
        expect(source).toContain('enabled: open');
        expect(source).not.toContain('variant="dialog"');
        expect(source).not.toContain('aria-label="Close"');
        expect(newFrontendSource).not.toMatch(/Blanc/);
        expect(newFrontendSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });

    test('TC-U3-01 · service-area radios expose territory mode and zero-data guidance', () => {
        const source = fs.readFileSync(DIALOG_PATH, 'utf8');

        expect(source).toContain('className="blanc-eyebrow">SERVICE AREA');
        expect(source).toContain('type="radio"');
        expect(source).toContain('Same as company settings');
        expect(source).toContain('Custom ZIP list');
        expect(source).toContain('Currently: ZIP list');
        expect(source).toContain('Currently: radius areas');
        expect(source).toContain('territory.has_data === false');
        expect(source).toContain('Your company has no service territory data yet — leads are accepted everywhere until you add some');
    });

    test('TC-U4-01 · custom ZIP entry has advisory live parsing and server error feedback', () => {
        const source = fs.readFileSync(DIALOG_PATH, 'utf8');
        const compact = collapse(source);

        expect(source).toContain('split(/[\\s,;]+/)');
        expect(compact).toMatch(/<FloatingField[^>]*textarea[^>]*rows=\{4\}[^>]*label="ZIP codes"/);
        expect(source).toContain('ZIP codes recognized');
        expect(source).toContain("entries don't look like ZIP codes");
        expect(compact).toMatch(/onError: \(error: Error\) => \{ toast\.error\(error\.message/);
    });

    test('TC-U5-01 · checkbox grids render only from catalogs returned by GET', () => {
        const source = fs.readFileSync(DIALOG_PATH, 'utf8');
        const frontendSource = readFilesRecursively(path.join(ROOT, 'frontend/src'))
            .map(filename => fs.readFileSync(filename, 'utf8'))
            .join('\n');

        expect(source).toContain('catalogs.unit_types.map');
        expect(source).toContain('catalogs.brands.map');
        expect(source).toContain('<Checkbox');
        expect(source.match(/grid grid-cols-2 sm:grid-cols-3 gap-2/g)).toHaveLength(2);
        expect(source.match(/No filter — all leads accepted/g)).toHaveLength(2);
        expect(frontendSource).not.toMatch(/Vent Hood|Speed Queen|Thermador/);
    });

    test('TC-U6-01 · GET and PUT wiring invalidates, toasts, and closes only on success', () => {
        const apiSource = fs.readFileSync(API_PATH, 'utf8');
        const dialogSource = fs.readFileSync(DIALOG_PATH, 'utf8');
        const compactApi = collapse(apiSource);
        const mutationStart = dialogSource.indexOf('const saveMutation');
        const handlerStart = dialogSource.indexOf('const handleSave');
        const mutationSource = dialogSource.slice(mutationStart, handlerStart);
        const errorStart = mutationSource.indexOf('onError:');
        const successSource = mutationSource.slice(0, errorStart);
        const errorSource = mutationSource.slice(errorStart);

        expect(apiSource).toContain("import { authedFetch } from './apiClient'");
        expect(apiSource).toContain('export interface RelyLeadsSettings');
        expect(apiSource).toContain('export interface RelyLeadsSettingsResponse');
        expect(compactApi).toMatch(/export async function fetchRelyLeadsSettings\(\): Promise<RelyLeadsSettingsResponse> \{ return request<RelyLeadsSettingsResponse>\(`\$\{API_BASE\}\/apps\/rely-leads\/settings`\); \}/);
        expect(compactApi).toMatch(/export async function saveRelyLeadsSettings\(settings: RelyLeadsSettings\).*method: 'PUT'.*body: JSON\.stringify\(settings\)/);
        expect(successSource).toContain("invalidateQueries({ queryKey: ['rely-leads-settings'] })");
        expect(successSource).toContain("toast.success('Settings saved')");
        expect(successSource).toContain('onOpenChange(false)');
        expect(errorSource).toContain('toast.error(error.message');
        expect(errorSource).not.toContain('onOpenChange(false)');
    });

    test('TC-S6-02 · marketplace mount and company scoping remain inherited and protected', () => {
        const serverSource = collapse(read('src/server.js'));
        const routerSource = read('backend/src/routes/marketplace.js');
        const helper = routerSource.match(/function companyId\(req\)\s*\{[\s\S]*?\n\}/);

        expect(serverSource).toMatch(/app\.use\('\/api\/marketplace', authenticate, requirePermission\('tenant\.integrations\.manage'\), requireCompanyAccess, marketplaceRouter\);/);
        expect(helper).not.toBeNull();
        expect(helper[0]).toContain('req.companyFilter?.company_id');
        expect(routerSource.replace(helper[0], '')).not.toMatch(/company_id/);
    });
});

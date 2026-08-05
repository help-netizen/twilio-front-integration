import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import componentSource from './AppVersionModeration.tsx?raw';
import pageSource from '../../pages/SuperAdminPage.tsx?raw';
import apiSource from '../../services/platformAppReviewsApi.ts?raw';
import {
    AppReviewDetail,
    AppReviewQueue,
    reviewActionsFor,
} from './AppVersionModeration';
import type {
    AppVersionReviewDetail,
    AppVersionReviewRequest,
} from '../../services/platformAppReviewsApi';

const request: AppVersionReviewRequest = {
    version_id: '10000000-0000-4000-8000-000000000001',
    app_id: '91',
    version_number: 'builder-2',
    status: 'in_review',
    submitted_at: '2026-08-01T14:00:00.000Z',
    created_at: '2026-08-01T13:00:00.000Z',
    reviewed_at: null,
    published_at: null,
    rejection_reason: null,
    app_key: 'task-digest',
    app_name: 'Task digest',
    app_type: 'private',
    company_id: '20000000-0000-4000-8000-000000000001',
    company_name: 'Tenant A',
    company_timezone: 'America/New_York',
};

const detail: AppVersionReviewDetail = {
    version: {
        id: request.version_id,
        app_id: request.app_id,
        version_number: request.version_number,
        status: 'in_review',
        source_sha256: 'a'.repeat(64),
        scanner_report: { parsed: true, dry_run: { ok: true } },
        sandbox_run: { ok: true, usage: { wall_ms: 4 } },
        created_at: request.created_at,
        submitted_at: request.submitted_at,
        reviewed_at: null,
        published_at: null,
        rejection_reason: null,
        tools: [
            { name: 'svc.list_jobs', kind: 'read' as const },
            { name: 'svc.create_task', kind: 'write' as const },
        ],
        suggested_schedule: { kind: 'daily' as const, at: '07:00' },
        data_collections: [{ name: 'purchases', key_fields: ['estimate_id'], columns: [{ key: 'estimate_id', type: 'number' }] }],
        actions: [{ id: 'mark_ordered', label: 'Mark ordered' }],
        subscribes: ['estimate.approved'],
        connections: [{ name: 'supplier', base_url: 'https://api.supplier.com', auth: { kind: 'bearer' } }],
        settings: [{ key: 'supplier_email', label: 'Supplier email', type: 'email', required: true }],
    },
    app: {
        id: request.app_id,
        app_key: request.app_key,
        name: request.app_name,
        provider_name: 'Albusto App Studio',
        category: 'custom',
        app_type: 'private',
        short_description: 'Summarizes open jobs.',
        long_description: 'Summarizes open jobs for the morning dispatch review.',
        logo_url: null,
        requested_scopes: [],
        metadata: {},
    },
    company: {
        id: request.company_id,
        name: request.company_name,
        timezone: request.company_timezone,
    },
    previous_version: {
        id: '10000000-0000-4000-8000-000000000002',
        version_number: 'builder-1',
        status: 'published',
        source_sha256: 'b'.repeat(64),
    },
    source_diff: {
        lines: [
            { type: 'removed', old_line: 1, new_line: null, text: 'return oldValue;' },
            { type: 'added', old_line: null, new_line: 1, text: 'return newValue;' },
        ],
        truncated: false,
        added_lines: 1,
        removed_lines: 1,
    },
    chats: [{
        id: 'chat-1',
        title: 'Task digest builder',
        created_at: request.created_at,
        messages: [
            {
                id: 'message-1',
                role: 'user',
                text: 'Build a morning task digest.',
                model: null,
                token_usage: {},
                version_id: null,
                created_at: request.created_at,
            },
            {
                id: 'message-2',
                role: 'assistant',
                text: 'Created a validated draft.',
                model: 'test-model',
                token_usage: {},
                version_id: request.version_id,
                created_at: request.created_at,
            },
        ],
    }],
};

const callbacks = {
    onShowCode: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onRevoke: vi.fn(),
};

describe('APP-MOD-001 super-admin Apps UI', () => {
    it('renders the left queue and complete review card with approve/reject actions', () => {
        const queueMarkup = renderToStaticMarkup(
            <AppReviewQueue
                requests={[request]}
                selectedId={request.version_id}
                busyId={null}
                onSelect={vi.fn()}
            />,
        );
        expect(queueMarkup).toContain('Task digest');
        expect(queueMarkup).toContain('Tenant A');
        expect(queueMarkup).toContain('builder-2');

        const detailMarkup = renderToStaticMarkup(
            <AppReviewDetail
                detail={detail}
                sourceLoading={false}
                busy={false}
                {...callbacks}
            />,
        );
        expect(detailMarkup).toContain('Approve');
        expect(detailMarkup).toContain('Reject');
        expect(detailMarkup).not.toContain('>Revoke<');
        expect(detailMarkup).toContain('Requested tools');
        expect(detailMarkup).toContain('svc.list_jobs');
        // The write tool and the reach it asks for must be legible to a moderator.
        expect(detailMarkup).toContain('svc.create_task');
        expect(detailMarkup).toContain('Capabilities');
        expect(detailMarkup).toContain('https://api.supplier.com');
        expect(detailMarkup).toContain('estimate.approved');
        expect(detailMarkup).toContain('Supplier email');
        expect(detailMarkup).toContain('Latest sandbox validation');
        expect(detailMarkup).toContain('return newValue;');
        expect(detailMarkup).toContain('Build a morning task digest.');
        expect(detailMarkup).toContain('Show code');
    });

    it('reveals source only after it is supplied and shows revoke only for published versions', () => {
        const published = {
            ...detail,
            version: { ...detail.version, status: 'published' as const },
        };
        const markup = renderToStaticMarkup(
            <AppReviewDetail
                detail={published}
                sourceCode="export async function run() { return true; }"
                sourceLoading={false}
                busy={false}
                {...callbacks}
            />,
        );
        expect(markup).toContain('Revoke');
        expect(markup).not.toContain('>Approve<');
        expect(markup).toContain('export async function run()');
        expect(markup).not.toContain('Show code');
    });

    it('declares exact actions for each version status', () => {
        expect(reviewActionsFor('in_review')).toEqual({ approve: true, reject: true, revoke: false });
        expect(reviewActionsFor('published')).toEqual({ approve: false, reject: false, revoke: true });
        for (const status of ['draft', 'submitted', 'approved', 'rejected', 'revoked'] as const) {
            expect(reviewActionsFor(status)).toEqual({ approve: false, reject: false, revoke: false });
        }
    });

    it('uses the canonical Apps tab, token-only layout, reject dialog, and authenticated API', () => {
        expect(pageSource).toContain('<TabsTrigger value="apps">Apps</TabsTrigger>');
        expect(componentSource).toContain("lg:grid-cols-[280px_minmax(0,1fr)]");
        expect(componentSource).toContain('<DialogContent variant="dialog">');
        expect(componentSource).toContain('<FloatingField');
        expect(componentSource).not.toMatch(/#[0-9a-f]{3,8}/i);
        expect(componentSource).not.toMatch(/>Blanc</);
        expect(apiSource).toContain("const API_BASE = '/api/platform/app-reviews'");
        expect(apiSource).toContain('authedFetch');
        expect(apiSource).not.toMatch(/[?&]company_id=|JSON\.stringify\([^)]*company_id/);
    });
});

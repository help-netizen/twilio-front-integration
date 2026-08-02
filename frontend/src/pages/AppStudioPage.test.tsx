import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import pageSource from './AppStudioPage.tsx?raw';
import apiSource from '../services/appStudioApi.ts?raw';
import {
    AppStudioAccessDenied,
    AppStudioWorkspace,
    appStudioSandboxResult,
    appStudioVersionLabel,
    canAccessAppStudio,
} from './AppStudioPage';

const version = {
    id: 'version-1',
    version_number: 'builder-1',
    status: 'draft',
    tools: ['svc.list_tasks'],
    scanner_report: { dry_run: { result: 'Today: 6 jobs scheduled.' } },
};

const baseProps = {
    chats: [{ id: 'chat-1', app_id: '91', title: 'Task digest', app_name: 'Task digest', message_count: 2 }],
    selectedChatId: 'chat-1',
    messages: [
        { id: 'message-1', role: 'user' as const, text: 'Build a daily task digest.' },
        {
            id: 'message-2',
            role: 'assistant' as const,
            text: 'Summarizes open tasks every morning.',
            version_id: 'version-1',
        },
    ],
    versions: [version],
    profile: {
        name: 'Task digest',
        description: 'Summarizes open tasks every morning.',
        version,
    },
    loading: false,
    error: null,
    quotaExhausted: false,
    composer: '',
    creating: false,
    sending: false,
    profileOpen: false,
    onSelectChat: vi.fn(),
    onNewApp: vi.fn(),
    onComposerChange: vi.fn(),
    onSend: vi.fn(),
    onProfileOpenChange: vi.fn(),
};

describe('APP-SVC-001 App Studio page', () => {
    it('renders the app list, builder chat, version plaque, and desktop profile panel', () => {
        const markup = renderToStaticMarkup(<AppStudioWorkspace {...baseProps} />);
        expect(markup).toContain('Your apps');
        expect(markup).toContain('Build a daily task digest.');
        expect(markup).toContain('Version 1 · draft');
        expect(markup).toContain('data-testid="app-profile-panel"');
        expect(markup).toContain('svc.list_tasks');
        expect(markup).toContain('New app');
    });

    it('uses the canonical responsive panel and floating field for the mobile profile and composer', () => {
        expect(pageSource).toContain('<DialogContent variant="panel">');
        expect(pageSource).toContain('<DialogPanelHeader>');
        expect(pageSource).toContain('<DialogBody className="md:px-8 md:py-7">');
        expect(pageSource).toContain('<FloatingField');
        expect(pageSource).not.toMatch(/>Blanc</);
    });

    it('shows what the draft returned in the sandbox, not just the bot\'s description', () => {
        const markup = renderToStaticMarkup(<AppStudioWorkspace {...baseProps} />);
        expect(markup).toContain('Sandbox result');
        expect(markup).toContain('Today: 6 jobs scheduled.');

        expect(appStudioSandboxResult({ ...version, scanner_report: {} })).toBeNull();
        expect(appStudioSandboxResult({
            ...version,
            scanner_report: { dry_run: { result: { jobs: 6 } } },
        })).toContain('"jobs": 6');
    });

    it('renders empty, loading, error, and quota states', () => {
        expect(renderToStaticMarkup(
            <AppStudioWorkspace {...baseProps} chats={[]} selectedChatId={null} messages={[]} versions={[]} profile={null} />,
        )).toContain('No apps yet');
        expect(renderToStaticMarkup(<AppStudioWorkspace {...baseProps} loading />))
            .toContain('Loading App Studio');
        expect(renderToStaticMarkup(<AppStudioWorkspace {...baseProps} error="Runner service unavailable." />))
            .toContain('Runner service unavailable.');
        expect(renderToStaticMarkup(<AppStudioWorkspace {...baseProps} quotaExhausted />))
            .toContain('generation quota is exhausted');
    });

    it('returns an explicit 403 surface for every non-admin role', () => {
        expect(canAccessAppStudio('tenant_admin')).toBe(true);
        for (const role of ['manager', 'dispatcher', 'provider', 'custom', null]) {
            expect(canAccessAppStudio(role)).toBe(false);
        }
        const markup = renderToStaticMarkup(<AppStudioAccessDenied />);
        expect(markup).toContain('data-status="403"');
        expect(markup).toContain('available only to company admins');
    });

    it('uses only the authenticated tenant-scoped App Studio API', () => {
        expect(apiSource).toContain("const API_BASE = '/api/app-studio'");
        expect(apiSource).toContain('authedFetch');
        expect(apiSource).not.toContain('company_id');
        expect(appStudioVersionLabel(version)).toBe('Version 1 · draft');
    });
});

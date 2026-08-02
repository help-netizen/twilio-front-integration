import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppViewDocument, type ViewDocument } from './AppViewBlocks';

function render(document: ViewDocument): string {
    return renderToStaticMarkup(
        <MemoryRouter>
            <AppViewDocument document={document} />
        </MemoryRouter>
    );
}

describe('APP-VIEW-001 view document renderer', () => {
    it('renders every v1 block type', () => {
        const markup = render({
            view_version: 1,
            blocks: [
                { type: 'stat_row', items: [{ label: 'Outstanding', value: '$4,180', tone: 'danger', trend: '+$620 this week' }] },
                { type: 'chart', chart_type: 'bar', series: [{ label: 'Miles', value: 1640 }], format: 'currency' },
                {
                    type: 'table',
                    title: 'Jobs',
                    columns: [
                        { key: 'job', label: 'Job', type: 'entity', align: 'left' },
                        { key: 'amount', label: 'Balance', type: 'currency', align: 'right' },
                    ],
                    rows: [{ job: { entity: 'job', id: 1219, label: 'NAC-1219' }, amount: 192 }],
                },
                { type: 'list', items: [{ title: 'Second visit needed', badge: { label: '14 days', tone: 'danger' } }] },
                { type: 'text', text: 'Collected before noon.' },
                { type: 'empty', text: 'Nothing outstanding.' },
            ],
        });

        expect(markup).toContain('Outstanding');
        expect(markup).toContain('+$620 this week');
        expect(markup).toContain('$1,640');
        expect(markup).toContain('NAC-1219');
        expect(markup).toContain('$192.00');
        expect(markup).toContain('14 days');
        expect(markup).toContain('Collected before noon.');
        expect(markup).toContain('Nothing outstanding.');
    });

    it('never lets app content reach the page as markup', () => {
        const markup = render({
            view_version: 1,
            blocks: [
                { type: 'text', text: '<img src=x onerror="alert(1)">' },
                { type: 'list', items: [{ title: '<script>alert(2)</script>' }] },
            ],
        });

        expect(markup).not.toContain('<img');
        expect(markup).not.toContain('<script>');
        expect(markup).toContain('&lt;img');
    });

    it('ignores a block type this build does not know instead of dumping it', () => {
        const markup = render({
            view_version: 1,
            // A newer app targeting a later view version must degrade, not leak.
            blocks: [{ type: 'timeline', events: ['secret'] } as never, { type: 'text', text: 'Still here.' }],
        });

        expect(markup).not.toContain('secret');
        expect(markup).toContain('Still here.');
    });

    it('says so when an app returns no blocks', () => {
        expect(render({ view_version: 1, blocks: [] })).toContain('returned nothing to show');
    });
});

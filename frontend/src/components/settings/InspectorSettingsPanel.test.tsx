import { describe, expect, it } from 'vitest';
import panelSource from './InspectorSettingsPanel.tsx?raw';
import apiSource from '../../services/marketplaceApi.ts?raw';
import integrationsSource from '../../pages/IntegrationsPage.tsx?raw';
import { formatInspectorSchedule, toggleInspectorStatus } from './InspectorSettingsPanel';

describe('Inspector settings panel', () => {
    it('uses the canonical responsive panel and approved information architecture', () => {
        expect(panelSource).toContain('<DialogContent variant="panel">');
        expect(panelSource).toContain('<DialogPanelHeader');
        expect(panelSource).toContain('<DialogBody');
        expect(panelSource).toContain('<DialogPanelFooter>');
        expect(panelSource).toContain('Enable Inspector');
        expect(panelSource).toContain('Ignore job statuses');
        expect(panelSource).toContain('Ignore lead statuses');
        expect(panelSource).toContain('Agent instruction');
        expect(panelSource).toContain('type="search"');
        expect(panelSource).not.toContain('Blanc');
    });

    it('adds and removes exact published FSM status names without rewriting them', () => {
        expect(toggleInspectorStatus(['Visit completed'], 'Canceled')).toEqual([
            'Visit completed',
            'Canceled',
        ]);
        expect(toggleInspectorStatus(['Visit completed', 'Canceled'], 'Visit completed')).toEqual([
            'Canceled',
        ]);
    });

    it('formats the read-only company-local noon schedule', () => {
        expect(formatInspectorSchedule({
            frequency: 'daily',
            after_local_time: '12:00',
            timezone: 'America/New_York',
        })).toBe('After 12:00 PM · America/New_York');
    });

    it('sends the exact editable settings object and does not autosave', () => {
        expect(apiSource).toContain('body: JSON.stringify(settings)');
        expect(apiSource).toContain("`${API_BASE}/apps/inspector/settings`");
        expect(panelSource).toContain('saveMutation.mutate(draft)');
        expect(panelSource).not.toContain('onBlur={() => saveMutation');
    });

    it('opens and closes from the Marketplace app search parameter', () => {
        expect(integrationsSource).toContain("searchParams.get('app') === 'inspector'");
        expect(integrationsSource).toContain("next.set('app', 'inspector')");
        expect(integrationsSource).toContain("next.delete('app')");
        expect(integrationsSource).toContain('<InspectorSettingsPanel open={inspectorSettingsOpen}');
    });
});

import { describe, expect, it } from 'vitest';
import appSource from '../../App.tsx?raw';
import leadPageSource from '../../pages/OutboundLeadCallerSettingsPage.tsx?raw';
import partsPageSource from '../../pages/OutboundPartsCallerSettingsPage.tsx?raw';
import marketplaceApiSource from '../../services/marketplaceApi.ts?raw';
import fieldsSource from './AgentCallWindowFields.tsx?raw';
import { SETTINGS_NAV } from './settingsNav';

describe('AGENT-CALL-WINDOW-001 settings surfaces', () => {
    it('SAB-CW-UI-PATTERN: both app pages reuse the company/custom floating-label block', () => {
        expect(fieldsSource).toContain('Same as company settings');
        expect(fieldsSource).toContain('Custom schedule');
        expect(fieldsSource).toContain('<FloatingField');
        expect(fieldsSource).toContain('type="time"');
        expect(fieldsSource).toContain('calling DAYS'.toUpperCase());
        expect(fieldsSource).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(leadPageSource).toContain('<AgentCallWindowFields');
        expect(partsPageSource).toContain('<AgentCallWindowFields');
    });

    it('parts caller is mounted as a protected settings-aligned app page', () => {
        expect(appSource).toContain('path="/settings/integrations/outbound-parts-caller"');
        expect(appSource).toContain('<OutboundPartsCallerSettingsPage />');
        const phoneAi = SETTINGS_NAV.find(group => group.id === 'phone-ai');
        expect(phoneAi?.links.some(link => link.to === '/settings/integrations/outbound-parts-caller'))
            .toBe(true);
        expect(marketplaceApiSource).toContain('/apps/outbound-parts-caller/settings');
    });

    it('inherit serializes as null and custom serializes all three window dimensions', () => {
        expect(leadPageSource).toContain("windowMode === 'custom' ? 'custom' : null");
        expect(leadPageSource).toContain('calling_window_work_days:');
        expect(partsPageSource).toContain("windowMode === 'custom' ? 'custom' : null");
        expect(partsPageSource).toContain('calling_window_work_days:');
    });
});

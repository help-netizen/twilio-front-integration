/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getLeadActionVisibility } from './LeadActionButtons';
import { getLeadStatusPillStyle, LEAD_STATUS_COLORS } from './leadStatusStyles';
import actionsSource from './LeadActionButtons.tsx?raw';
import panelSource from './LeadDetailPanel.tsx?raw';
import footerSource from './LeadDetailSections.tsx?raw';
import barSource from './PulseLeadBar.tsx?raw';
import statusSource from './LeadStatusDropdown.tsx?raw';
import contactBarSource from '../contacts/PulseContactBar.tsx?raw';
import primitiveSource from '../pulse/PulsePinnedBar.tsx?raw';
import pageSource from '../../pages/PulsePage.tsx?raw';

const cssSource = readFileSync(new URL('../../pages/PulsePage.css', import.meta.url), 'utf8');

describe('PULSE-LEAD-PIN-001 — shared lead action predicates', () => {
    it('keeps the existing active, lost and converted action sets', () => {
        expect(getLeadActionVisibility({ Status: 'New', LeadLost: false })).toEqual({
            showConvert: true,
            showActivate: false,
            showMarkLost: true,
        });
        expect(getLeadActionVisibility({ Status: 'Lost', LeadLost: true })).toEqual({
            showConvert: false,
            showActivate: true,
            showMarkLost: false,
        });
        expect(getLeadActionVisibility({ Status: 'Converted', LeadLost: false })).toEqual({
            showConvert: false,
            showActivate: false,
            showMarkLost: true,
        });
    });

    it('shares one action renderer between the collapsed bar and full panel footer', () => {
        expect(barSource).toContain("import { LeadActionButtons } from './LeadActionButtons'");
        expect(footerSource).toContain("import { LeadActionButtons } from './LeadActionButtons'");
        expect(barSource).toContain('variant="bar"');
        expect(footerSource).toContain('variant="footer"');
    });

    it('mirrors the real overflow contents and existing Pulse callbacks', () => {
        expect(actionsSource).toContain('Mark Lost');
        expect(actionsSource).toContain('Delete Lead');
        expect(actionsSource).toContain('onMarkLost(lead.UUID)');
        expect(actionsSource).toContain('onDelete(lead.UUID)');
        expect(pageSource).toContain('onConvert={p.handleConvert}');
        expect(pageSource).toContain('onUpdateStatus={p.handleUpdateStatus}');
    });
});

describe('PULSE-LEAD-PIN-001 — status is state, not an action', () => {
    it('styles every named lead status and a safe custom-status fallback', () => {
        for (const [status, color] of Object.entries(LEAD_STATUS_COLORS)) {
            const pill = getLeadStatusPillStyle(status);
            expect(pill.color).toBe(color);
            expect(pill.bg).toMatch(/^rgba\(/);
        }
        expect(getLeadStatusPillStyle('Company custom state').color).toBe('#6B7280');
    });

    it('uses one DB-driven full-pill dropdown in both the bar and panel header', () => {
        expect(barSource).toContain('<LeadStatusDropdown lead={lead} onUpdateStatus={onUpdateStatus} compact />');
        expect(panelSource).toContain('<LeadStatusDropdown lead={lead} onUpdateStatus={onUpdateStatus} />');
        expect(statusSource).toContain("useFsmStates('lead', true)");
        expect(statusSource).toContain("useFsmActions('lead', lead.Status)");
        expect(statusSource).toContain('borderRadius: 999');
        expect(statusSource).toContain('lead-status-pill-dot');
        expect(statusSource).toContain('compact ? 26 : 42');
    });

    it('leaves Source as a full-panel-only chip', () => {
        expect(barSource).not.toContain('JobSource');
        expect(barSource).not.toContain('onUpdateSource');
        expect(panelSource).toContain("hasPermission('lead_source.view')");
        expect(panelSource).toContain("lead.JobSource || 'No Source'");
    });
});

describe('PULSE-LEAD-PIN-001 — sticky overlay wiring', () => {
    it('puts Contact and Lead bars inside the same sticky stack', () => {
        const stackStart = pageSource.indexOf('<div className="pulse-sticky-stack">');
        const stackEnd = pageSource.indexOf('</div>', stackStart);
        const stack = pageSource.slice(stackStart, stackEnd);

        expect(stackStart).toBeGreaterThan(-1);
        expect(stack).toContain('<PulseContactBar');
        expect(stack).toContain('<PulseLeadBar');
    });

    it('removes the 560px lead card from flow and hosts the existing panel in an overlay', () => {
        expect(pageSource).not.toContain('height: 560');
        expect(pageSource).toContain('<Dialog open={leadCardOpen} onOpenChange={setLeadCardOpen}>');
        expect(pageSource).toMatch(/<Dialog open=\{leadCardOpen\}[\s\S]*?<DialogContent variant="panel">[\s\S]*?<LeadDetailPanel/);
        expect(pageSource).toContain('<DialogBody className="p-0">');
    });

    it('keeps the owner-approved identity and action cluster boundaries', () => {
        expect(barSource).toContain('pulse-lead-bar-repair-type');
        expect(barSource).toContain('pulse-lead-bar-name-row');
        expect(barSource).not.toMatch(/Phone|MessageSquare|Mail/);
        expect(actionsSource).toContain('label="Edit"');
        expect(actionsSource).toContain('label="Convert to Job"');
        expect(actionsSource).toContain('label="More lead actions"');
    });
});

describe('PULSE-LEAD-PIN-001 — shared pinned-bar primitives and ladder', () => {
    it('uses the same shell, actions and expand primitive for Contact and Lead', () => {
        expect(contactBarSource).toContain('<PulsePinnedBar');
        expect(barSource).toContain('<PulsePinnedBar');
        expect(contactBarSource).toContain('<PulsePinnedBarExpand');
        expect(barSource).toContain('<PulsePinnedBarExpand');
        expect(primitiveSource).toContain("'pulse-pinned-bar-action'");
        expect(primitiveSource).toContain("aria-label={props['aria-label'] || label}");
    });

    it('has one desktop-only container ladder shared by both entities', () => {
        expect(cssSource.match(/@container \(max-width: 640px\)/g)).toHaveLength(1);
        expect(cssSource.match(/@container \(max-width: 440px\)/g)).toHaveLength(1);
        expect(cssSource).toContain('.pulse-pinned-bar-action-label { display: none; }');
        expect(cssSource).not.toMatch(/@container (?:contactbar|leadbar)/);
    });

    it('locks desktop height, action geometry and labelled mobile stacking', () => {
        expect(cssSource).toMatch(/\.pulse-lead-bar \{[\s\S]*?height: 68px;/);
        expect(cssSource).toMatch(/\.pulse-pinned-bar-action \{[\s\S]*?min-height: 40px;[\s\S]*?border-radius: 13px;/);
        expect(cssSource).toMatch(/\.pulse-pinned-bar-action svg \{[\s\S]*?width: 15px;[\s\S]*?height: 15px;/);
        expect(cssSource).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pulse-lead-bar[\s\S]*?'actions actions'/);
        expect(cssSource).not.toMatch(/@media \(max-width: 768px\)[\s\S]*?\.pulse-pinned-bar-action-label \{ display: none; \}/);
    });
});

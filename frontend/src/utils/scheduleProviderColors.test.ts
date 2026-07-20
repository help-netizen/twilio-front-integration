import { describe, expect, it } from 'vitest';
import {
    buildTechnicianColorRegistry,
    registeredTechnician,
    SCHEDULE_TECHNICIAN_PALETTE,
} from './scheduleProviderColors';

const ROSTER = Array.from({ length: 16 }, (_, index) => ({
    id: `tech-${String(index + 1).padStart(2, '0')}`,
    name: `Technician ${index + 1}`,
}));

describe('Schedule technician colour registry', () => {
    it('assigns the complete 16-person roster deterministically and without collisions', () => {
        const first = buildTechnicianColorRegistry(ROSTER);
        const shuffled = buildTechnicianColorRegistry([
            ...ROSTER.filter((_, index) => index % 2 === 0).reverse(),
            ...ROSTER.filter((_, index) => index % 2 === 1),
        ]);

        const firstColors = ROSTER.map(technician => (
            registeredTechnician(first, technician.id)?.color.accent
        ));
        const shuffledColors = ROSTER.map(technician => (
            registeredTechnician(shuffled, technician.id)?.color.accent
        ));

        expect(shuffledColors).toEqual(firstColors);
        expect(new Set(firstColors).size).toBe(16);
        expect(new Set(firstColors)).toEqual(new Set(SCHEDULE_TECHNICIAN_PALETTE));
        expect(first.showInitialsOnPins).toBe(false);
    });

    it('resolves id and name through the same registry entry', () => {
        const registry = buildTechnicianColorRegistry(ROSTER);
        expect(registeredTechnician(registry, ROSTER[4].id)).toBe(
            registeredTechnician(registry, ROSTER[4].name),
        );
    });

    it('enables initials once the finite palette must wrap', () => {
        const registry = buildTechnicianColorRegistry([
            ...ROSTER,
            { id: 'tech-17', name: 'Zara Young' },
        ]);
        expect(registry.showInitialsOnPins).toBe(true);
        expect(registeredTechnician(registry, 'tech-17')?.initials).toBe('ZY');
        expect(new Set(registry.roster.map(entry => entry.color.accent)).size).toBe(16);
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import modalSource from './CustomTimeModal.tsx?raw';
import { serviceAreaSelectionWarning } from './serviceAreaWarning';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiClient', () => ({ authedFetch }));

import { fetchTechnicianServiceAreaMatches } from '../../services/scheduleApi';

beforeEach(() => {
    authedFetch.mockReset();
});

describe('Custom Time Albusto service-area matching', () => {
    it('reads the active Albusto assignment seam and never Zenbooker assigned_territories', async () => {
        const data = {
            active_mode: 'list' as const,
            target_resolved: true,
            no_targets: false,
            target_ids: ['North'],
            matches: [{ technician_id: 'tech-1', wildcard: false, eligible: true }],
        };
        authedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn(async () => ({ ok: true, data })),
        });

        await expect(fetchTechnicianServiceAreaMatches({
            address: '12 Main St, Boston, MA 02135',
            lat: 42.36,
            lng: -71.06,
        })).resolves.toEqual(data);
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/schedule/technician-service-area-matches',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    address: '12 Main St, Boston, MA 02135',
                    lat: 42.36,
                    lng: -71.06,
                }),
            }),
        );
        expect(modalSource).not.toContain('assigned_territories');
        expect(modalSource).toContain('if (!result.target_resolved)');
    });

    it('warns for mismatch or failed lookup while manual confirmation remains selection-only', () => {
        expect(serviceAreaSelectionWarning({
            hasSelection: true,
            lookupFailed: false,
            eligible: false,
        })).toBe("This technician isn't assigned to this Albusto service area");
        expect(serviceAreaSelectionWarning({
            hasSelection: true,
            lookupFailed: true,
        })).toBe('Service-area eligibility could not be verified');
        expect(serviceAreaSelectionWarning({
            hasSelection: false,
            lookupFailed: true,
        })).toBeNull();
        expect(modalSource).toContain('disabled={!selectedSlot}');
        expect(modalSource).not.toContain('disabled={!selectedSlot || areaMatchError}');
    });
});

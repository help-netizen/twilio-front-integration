import type { Technician } from '../../services/techniciansApi';
import type { TechnicianBaseLocation } from '../../services/technicianBaseLocationsApi';

export type TechnicianRosterRow = Technician & {
    base?: TechnicianBaseLocation;
};

/** Attach saved bases without replacing canonical technician/profile data. */
export function mergeTechnicianRosterRows(
    technicians: readonly Technician[],
    bases: readonly TechnicianBaseLocation[],
): TechnicianRosterRow[] {
    const baseByTechnician = new Map(bases.map(base => [String(base.tech_id), base]));

    return technicians.map(technician => ({
        ...technician,
        base: baseByTechnician.get(String(technician.tech_id)),
    }));
}

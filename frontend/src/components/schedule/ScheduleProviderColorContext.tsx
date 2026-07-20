import { createContext, useContext, type ReactNode } from 'react';
import {
    buildTechnicianColorRegistry,
    colorForTechnician,
    type TechnicianColorRegistry,
} from '../../utils/scheduleProviderColors';

const EMPTY_REGISTRY = buildTechnicianColorRegistry([]);
const ScheduleProviderColorContext = createContext<TechnicianColorRegistry>(EMPTY_REGISTRY);

export function ScheduleProviderColorProvider({
    registry,
    children,
}: {
    registry: TechnicianColorRegistry;
    children: ReactNode;
}) {
    return (
        <ScheduleProviderColorContext.Provider value={registry}>
            {children}
        </ScheduleProviderColorContext.Provider>
    );
}

export function useScheduleProviderColorRegistry(): TechnicianColorRegistry {
    return useContext(ScheduleProviderColorContext);
}

export function useScheduleProviderColor(key: string | null | undefined) {
    const registry = useScheduleProviderColorRegistry();
    return colorForTechnician(registry, key);
}

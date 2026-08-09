import { useState, useEffect, useCallback } from 'react';
import { checkZipCode } from '../services/zenbookerApi';

export interface ZipCheckState {
    territoryLoading: boolean;
    territoryError: string;
    zipExists: boolean | null;
    zipArea: string;
    matchedZip: string;  // the actual zip code from the match (useful when user searched by city)
    zipSource: string;
    coords: { lat: number; lng: number } | null;
    setCoords: (v: { lat: number; lng: number } | null) => void;
}

/**
 * Shared hook for territory checking against the LOCAL service_territories
 * table (via /api/zip-check).
 *
 * ZB-DECOUPLE C4b: the old Zenbooker background call (checkServiceArea — it
 * existed solely to fetch a ZB territory_id for ZB timeslots) is GONE. Coords
 * now come from the address autocomplete / lead record; the native slot engine
 * needs no territory id.
 *
 * @param query - zip code, city, or area to check (debounced at 600ms, minimum 3 chars)
 */
export function useZipCheck(query: string): ZipCheckState {
    const [territoryLoading, setTerritoryLoading] = useState(false);
    const [territoryError, setTerritoryError] = useState('');
    const [zipExists, setZipExists] = useState<boolean | null>(null);
    const [zipArea, setZipArea] = useState('');
    const [matchedZip, setMatchedZip] = useState('');
    const [zipSource, setZipSource] = useState('');
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

    const checkTerritory = useCallback(async (val: string) => {
        if (!val || val.length < 3) {
            setTerritoryError('');
            setZipExists(null); setZipArea(''); setMatchedZip(''); setZipSource('');
            return;
        }
        setTerritoryLoading(true); setTerritoryError('');
        setZipExists(null); setZipArea(''); setMatchedZip(''); setZipSource('');

        try {
            const fast = await checkZipCode(val);
            setZipExists(fast.exists);
            setZipArea(fast.area || '');
            setMatchedZip(fast.zip || '');
            setZipSource('fast');
            if (!fast.exists) setTerritoryError('Not in any service area');
        } catch (err: any) {
            console.error('[ZipCheck] Failed:', err?.message || err);
            setZipExists(false);
            setZipSource('none');
            setTerritoryError('Service area check failed');
        }
        setTerritoryLoading(false);
    }, []);

    // Debounce: fire check after 600ms when query changes, minimum 3 chars
    useEffect(() => {
        const trimmed = query.trim();
        const timer = setTimeout(() => {
            if (trimmed.length >= 3) checkTerritory(trimmed);
            else {
                setTerritoryError('');
                setZipExists(null); setZipArea(''); setMatchedZip(''); setZipSource('');
            }
        }, 600);
        return () => clearTimeout(timer);
    }, [query, checkTerritory]);

    return { territoryLoading, territoryError, zipExists, zipArea, matchedZip, zipSource, coords, setCoords };
}

import { useState, useEffect, useCallback } from 'react';
import * as zenbookerApi from '../services/zenbookerApi';
import type { ServiceAreaResult } from '../services/zenbookerApi';

export interface ZipCheckState {
    territoryResult: ServiceAreaResult | null;
    territoryLoading: boolean;
    territoryError: string;
    zipExists: boolean | null;
    zipArea: string;
    matchedZip: string;  // the actual zip code from the match (useful when user searched by city)
    zipSource: string;
    zbLoading: boolean;  // true while Zenbooker background call is in progress
    coords: { lat: number; lng: number } | null;
    setCoords: (v: { lat: number; lng: number } | null) => void;
}

/**
 * Shared hook for territory checking.
 * Territory check uses ONLY the local service_territories table (managed via Settings).
 * Zenbooker is called in the background solely for territory_id/coords needed by timeslots.
 *
 * @param query - zip code, city, or area to check (debounced at 600ms, minimum 3 chars)
 */
export function useZipCheck(query: string): ZipCheckState {
    const [territoryResult, setTerritoryResult] = useState<ServiceAreaResult | null>(null);
    const [territoryLoading, setTerritoryLoading] = useState(false);
    const [territoryError, setTerritoryError] = useState('');
    const [zipExists, setZipExists] = useState<boolean | null>(null);
    const [zipArea, setZipArea] = useState('');
    const [matchedZip, setMatchedZip] = useState('');
    const [zipSource, setZipSource] = useState('');
    const [zbLoading, setZbLoading] = useState(false);
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

    const checkTerritory = useCallback(async (val: string) => {
        if (!val || val.length < 3) {
            setTerritoryResult(null); setTerritoryError('');
            setZipExists(null); setZipArea(''); setMatchedZip(''); setZipSource('');
            setZbLoading(false);
            return;
        }
        setTerritoryLoading(true); setTerritoryError('');
        setZipExists(null); setZipArea(''); setMatchedZip(''); setZipSource('');
        setZbLoading(true); setTerritoryResult(null);

        console.log('[ZipCheck] Checking service_territories for:', val);

        // Territory check — ONLY service_territories (via /api/zip-check)
        let fastZip = '';
        try {
            const fast = await zenbookerApi.checkZipCode(val);
            console.log('[ZipCheck] Result:', fast);
            fastZip = fast.zip || '';
            setZipExists(fast.exists);
            setZipArea(fast.area || '');
            setMatchedZip(fastZip);
            setZipSource('fast');
            if (!fast.exists) setTerritoryError('Not in any service area');
        } catch (err: any) {
            console.error('[ZipCheck] Failed:', err?.message || err);
            setZipExists(false);
            setZipSource('none');
            setTerritoryError('Service area check failed');
        }
        setTerritoryLoading(false);

        // Zenbooker background call — only for territory_id & coords (needed for timeslots)
        // Does NOT affect territory check result (zipExists/zipArea)
        const zbQuery: { postal_code?: string; address?: string } = /^\d{3,10}$/.test(val)
            ? { postal_code: val }
            : fastZip
                ? { postal_code: fastZip }
                : { address: val };

        zenbookerApi.checkServiceArea(zbQuery).then((zbResult: ServiceAreaResult) => {
            setTerritoryResult(zbResult);
            setZbLoading(false);
            if (zbResult.customer_location?.coordinates) setCoords(zbResult.customer_location.coordinates);
        }).catch(() => {
            setTerritoryResult(null);
            setZbLoading(false);
        });
    }, []);

    // Debounce: fire check after 600ms when query changes, minimum 3 chars
    useEffect(() => {
        const trimmed = query.trim();
        const timer = setTimeout(() => {
            if (trimmed.length >= 3) checkTerritory(trimmed);
            else if (trimmed.length < 3) {
                setTerritoryResult(null); setTerritoryError('');
                setZipExists(null); setZipArea(''); setMatchedZip(''); setZipSource('');
                setZbLoading(false);
            }
        }, 600);
        return () => clearTimeout(timer);
    }, [query, checkTerritory]);

    return { territoryResult, territoryLoading, territoryError, zipExists, zipArea, matchedZip, zipSource, zbLoading, coords, setCoords };
}

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
 * Accepts zip code, city name, or area name — searches local service_territories table.
 * Then loads Zenbooker territory data in the background (needed for timeslots).
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

        console.log('[ZipCheck] Starting checks for:', val);

        // 1) Fast API — searches by zip, city, or area in service_territories
        let fastZip = '';
        try {
            const fast = await zenbookerApi.checkZipCode(val);
            console.log('[ZipCheck] ✓ Fast API responded:', fast);
            fastZip = fast.zip || '';
            setZipExists(fast.exists);
            setZipArea(fast.area || '');
            setMatchedZip(fastZip);
            setZipSource('fast');
            setTerritoryLoading(false);
            if (!fast.exists) setTerritoryError('Not in any service area');
        } catch (fastErr: any) {
            console.warn('[ZipCheck] ✗ Fast API failed:', fastErr?.message || fastErr);
            // Fast API failed — fall back to Zenbooker (awaited, not background)
            try {
                const zbFallback = await zenbookerApi.checkServiceArea(val);
                setZipExists(zbFallback.in_service_area);
                setZipArea(zbFallback.service_territory?.name || '');
                setZipSource('zenbooker');
                setTerritoryResult(zbFallback);
                setZbLoading(false);
                if (zbFallback.customer_location?.coordinates) setCoords(zbFallback.customer_location.coordinates);
                if (!zbFallback.in_service_area) setTerritoryError('Not in any service area');
            } catch {
                console.error('[ZipCheck] ✗ Both APIs failed!');
                setZipExists(false);
                setZipSource('none');
                setZbLoading(false);
                setTerritoryError('Service area check failed');
            }
            setTerritoryLoading(false);
            return; // Zenbooker already called in fallback
        }

        // 2) Zenbooker — fire-and-forget in background (needed for territory ID & coords for timeslots)
        //    Use matched zip from fast API, or pass raw text as address for Zenbooker
        const zbQuery: { postal_code?: string; address?: string } = /^\d{3,10}$/.test(val)
            ? { postal_code: val }
            : fastZip
                ? { postal_code: fastZip }    // fast API found a zip match for this city/area
                : { address: val };            // pass raw text as address to Zenbooker

        zenbookerApi.checkServiceArea(zbQuery).then((zbResult: ServiceAreaResult) => {
            console.log('[ZipCheck] Zenbooker background result:', zbResult);
            setTerritoryResult(zbResult);
            setZbLoading(false);
            if (zbResult.customer_location?.coordinates) setCoords(zbResult.customer_location.coordinates);
        }).catch((zbErr: any) => {
            console.warn('[ZipCheck] Zenbooker background call failed:', zbErr?.message || zbErr);
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

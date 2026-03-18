import { useState, useEffect, useCallback } from 'react';
import * as zenbookerApi from '../services/zenbookerApi';
import type { ServiceAreaResult } from '../services/zenbookerApi';

export interface ZipCheckState {
    territoryResult: ServiceAreaResult | null;
    territoryLoading: boolean;
    territoryError: string;
    zipExists: boolean | null;
    zipArea: string;
    zipSource: string;
    coords: { lat: number; lng: number } | null;
    setCoords: (v: { lat: number; lng: number } | null) => void;
}

/**
 * Shared hook for zip-code service area checking.
 * Uses the fast rely-lead-processor API for instant UI feedback,
 * then loads Zenbooker territory data in the background (needed for timeslots).
 *
 * @param zip - postal code to check (debounced inside the hook at 600ms, minimum 4 chars)
 */
export function useZipCheck(zip: string): ZipCheckState {
    const [territoryResult, setTerritoryResult] = useState<ServiceAreaResult | null>(null);
    const [territoryLoading, setTerritoryLoading] = useState(false);
    const [territoryError, setTerritoryError] = useState('');
    const [zipExists, setZipExists] = useState<boolean | null>(null);
    const [zipArea, setZipArea] = useState('');
    const [zipSource, setZipSource] = useState('');
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

    const checkTerritory = useCallback(async (zipVal: string) => {
        if (!zipVal || zipVal.length < 3) {
            setTerritoryResult(null); setTerritoryError('');
            setZipExists(null); setZipArea(''); setZipSource('');
            return;
        }
        setTerritoryLoading(true); setTerritoryError('');
        setZipExists(null); setZipArea(''); setZipSource('');

        console.log('[ZipCheck] Starting checks for zip:', zipVal);

        // 1) Fast API — updates UI immediately, does NOT wait for Zenbooker
        try {
            const fast = await zenbookerApi.checkZipCode(zipVal);
            console.log('[ZipCheck] ✓ Fast API responded:', fast);
            setZipExists(fast.exists);
            setZipArea(fast.area || '');
            setZipSource('fast');
            setTerritoryLoading(false);
            if (!fast.exists) setTerritoryError('Zip code is not in any service area');
        } catch (fastErr: any) {
            console.warn('[ZipCheck] ✗ Fast API failed:', fastErr?.message || fastErr);
            // Fast API failed — fall back to Zenbooker
            try {
                const zbFallback = await zenbookerApi.checkServiceArea(zipVal);
                setZipExists(zbFallback.in_service_area);
                setZipArea(zbFallback.service_territory?.name || '');
                setZipSource('zenbooker');
                setTerritoryResult(zbFallback);
                if (zbFallback.customer_location?.coordinates) setCoords(zbFallback.customer_location.coordinates);
                if (!zbFallback.in_service_area) setTerritoryError('Zip code is not in any service area');
            } catch {
                console.error('[ZipCheck] ✗ Both APIs failed!');
                setZipExists(false);
                setZipSource('none');
                setTerritoryError('Service area check failed');
            }
            setTerritoryLoading(false);
            return; // Zenbooker already called in fallback
        }

        // 2) Zenbooker — fire-and-forget in background (needed for territory ID & coords for timeslots)
        zenbookerApi.checkServiceArea(zipVal).then((zbResult: ServiceAreaResult) => {
            console.log('[ZipCheck] Zenbooker background result:', zbResult);
            setTerritoryResult(zbResult);
            if (zbResult.customer_location?.coordinates) setCoords(zbResult.customer_location.coordinates);
        }).catch((zbErr: any) => {
            console.warn('[ZipCheck] Zenbooker background call failed:', zbErr?.message || zbErr);
            setTerritoryResult(null);
        });
    }, []);

    // Debounce: fire check after 600ms when zip changes, minimum 4 chars
    useEffect(() => {
        const trimmed = zip.trim();
        const timer = setTimeout(() => {
            if (trimmed.length >= 4) checkTerritory(trimmed);
            else if (trimmed.length < 3) {
                setTerritoryResult(null); setTerritoryError('');
                setZipExists(null); setZipArea(''); setZipSource('');
            }
        }, 600);
        return () => clearTimeout(timer);
    }, [zip, checkTerritory]);

    return { territoryResult, territoryLoading, territoryError, zipExists, zipArea, zipSource, coords, setCoords };
}

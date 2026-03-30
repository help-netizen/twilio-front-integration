/**
 * Dynamic Google Maps JS API loader.
 *
 * Loads the script once with `loading=async` (recommended by Google)
 * using the VITE_GOOGLE_MAPS_API_KEY env var via import.meta.env.
 *
 * Usage:
 *   await loadGoogleMaps();          // resolves when google.maps is ready
 *   loadGoogleMaps();                // fire-and-forget (script starts loading)
 */

let loadPromise: Promise<void> | null = null;

export function loadGoogleMaps(): Promise<void> {
    if (loadPromise) return loadPromise;

    // Already loaded (e.g. by another mechanism)
    if (typeof google !== 'undefined' && google.maps) {
        loadPromise = Promise.resolve();
        return loadPromise;
    }

    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.warn('[GoogleMaps] VITE_GOOGLE_MAPS_API_KEY is not configured — maps will not load');
        loadPromise = Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not configured'));
        return loadPromise;
    }

    loadPromise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&loading=async`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Google Maps JS API'));
        document.head.appendChild(script);
    });

    return loadPromise;
}

/// <reference types="google.maps" />

declare global {
    interface Window {
        google?: typeof google;
    }
}

import { useEffect, useState } from "react";
import { AddressAutocomplete } from "../components/AddressAutocomplete";
import { Loader2 } from "lucide-react";

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string;

function loadGoogleMapsScript(apiKey: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (window.google?.maps?.places) {
            resolve();
            return;
        }

        const existing = document.querySelector(
            'script[src*="maps.googleapis.com/maps/api/js"]'
        );
        if (existing) {
            existing.addEventListener("load", () => resolve());
            existing.addEventListener("error", () =>
                reject(new Error("Google Maps script failed to load"))
            );
            return;
        }

        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Google Maps script failed to load"));
        document.head.appendChild(script);
    });
}

export default function AutocompletePage() {
    const [mapsReady, setMapsReady] = useState(
        () => !!window.google?.maps?.places
    );
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (mapsReady) return;

        if (!GOOGLE_MAPS_API_KEY) {
            setError(
                "VITE_GOOGLE_MAPS_API_KEY is not set. Add it to frontend/.env and restart the dev server."
            );
            return;
        }

        loadGoogleMapsScript(GOOGLE_MAPS_API_KEY)
            .then(() => setMapsReady(true))
            .catch((err: Error) => setError(err.message));
    }, [mapsReady]);

    return (
        <div className="min-h-screen bg-background">
            <div className="max-w-2xl mx-auto p-6 pt-12">
                {/* Error state */}
                {error && (
                    <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
                        <p className="font-medium text-red-800">Configuration Error</p>
                        <p className="text-sm text-red-700">{error}</p>
                    </div>
                )}

                {/* Loading Google Maps */}
                {!mapsReady && !error && (
                    <div className="mb-6 flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        <span>Loading Google Maps API…</span>
                    </div>
                )}

                {/* Autocomplete Card */}
                {mapsReady && <AddressAutocomplete />}
            </div>
        </div>
    );
}

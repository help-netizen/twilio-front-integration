/**
 * Voice API client — token endpoint for the SoftPhone.
 */
import { authedFetch } from './apiClient';

export interface VoiceTokenResponse {
    token: string;
    identity: string;
    expiresAt: string;
    allowed: boolean;
}

/**
 * Fetch a Twilio Access Token for the current user.
 * Returns { allowed: false } if user doesn't have phone_calls_allowed.
 */
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
    const res = await authedFetch('/api/voice/token');
    if (!res.ok) {
        throw new Error(`Failed to fetch voice token: ${res.status} ${res.statusText}`);
    }
    return res.json();
}

/**
 * Check if the current user has phone call access (lightweight, no token).
 */
export async function checkPhoneAccess(): Promise<boolean> {
    try {
        const res = await authedFetch('/api/voice/phone-access');
        if (!res.ok) return false;
        const data = await res.json();
        return data.allowed === true;
    } catch {
        return false;
    }
}

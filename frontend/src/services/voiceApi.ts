/**
 * Voice API client — token endpoint for the SoftPhone.
 */
import { authedFetch } from './apiClient';

export interface VoiceTokenResponse {
    token: string;
    identity: string;
    expiresAt: string;
}

/**
 * Fetch a Twilio Access Token for the current user.
 */
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
    const res = await authedFetch('/api/voice/token');
    if (!res.ok) {
        throw new Error(`Failed to fetch voice token: ${res.status} ${res.statusText}`);
    }
    return res.json();
}

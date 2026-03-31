import type { Device, Call } from '@twilio/voice-sdk';

export type CallState = 'idle' | 'connecting' | 'ringing' | 'incoming' | 'connected' | 'ended' | 'failed';

export interface UseTwilioDeviceReturn {
    device: Device | null;
    activeCall: Call | null;
    incomingCall: Call | null;
    callState: CallState;
    callDuration: number;
    callerInfo: { number: string; contactName?: string } | null;
    makeCall: (to: string, params?: Record<string, string>) => Promise<void>;
    acceptCall: () => void;
    declineCall: () => void;
    hangUp: () => void;
    toggleMute: () => void;
    isMuted: boolean;
    sendDigits: (digits: string) => void;
    deviceReady: boolean;
    error: string | null;
    phoneAllowed: boolean;
    /** Number of incoming calls queued while dispatcher is busy */
    pendingCount: number;
    /** Caller info of the first pending call (for UI display) */
    pendingCallerInfo: { number: string } | null;
}

/**
 * useTwilioDevice — React hook that manages the Twilio Voice JS SDK Device lifecycle.
 *
 * Provides a complete interface for making/receiving WebRTC calls via the SoftPhone.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import { fetchVoiceToken } from '../services/voiceApi';
import { startRingtone, stopRingtone } from '../utils/ringtone';

export type CallState =
    | 'idle'
    | 'connecting'
    | 'ringing'
    | 'incoming'
    | 'connected'
    | 'ended'
    | 'failed';

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
}

export function useTwilioDevice(): UseTwilioDeviceReturn {
    const [device, setDevice] = useState<Device | null>(null);
    const [activeCall, setActiveCall] = useState<Call | null>(null);
    const [incomingCall, setIncomingCall] = useState<Call | null>(null);
    const [callState, setCallState] = useState<CallState>('idle');
    const [callDuration, setCallDuration] = useState(0);
    const [callerInfo, setCallerInfo] = useState<{ number: string; contactName?: string } | null>(null);
    const [deviceReady, setDeviceReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [phoneAllowed, setPhoneAllowed] = useState(true);

    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const connectedAtRef = useRef<number | null>(null);
    const deviceRef = useRef<Device | null>(null);

    // ─── Duration Timer ───────────────────────────────────────────────────────
    const startDurationTimer = useCallback(() => {
        connectedAtRef.current = Date.now();
        durationIntervalRef.current = setInterval(() => {
            if (connectedAtRef.current) {
                setCallDuration(Math.floor((Date.now() - connectedAtRef.current) / 1000));
            }
        }, 1000);
    }, []);

    const stopDurationTimer = useCallback(() => {
        if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
        }
        connectedAtRef.current = null;
    }, []);

    // ─── Call Event Handlers ─────────────────────────────────────────────────
    const attachCallHandlers = useCallback((call: Call) => {
        call.on('accept', () => {
            console.log('[SoftPhone] Call accepted/connected');
            setCallState('connected');
            startDurationTimer();
        });

        call.on('ringing', () => {
            console.log('[SoftPhone] Call ringing');
            setCallState('ringing');
        });

        call.on('disconnect', () => {
            console.log('[SoftPhone] Call disconnected');
            setCallState('ended');
            stopDurationTimer();
            setActiveCall(null);
            setIsMuted(false);
            // Auto-return to idle after 2s
            setTimeout(() => {
                setCallState('idle');
                setCallDuration(0);
                setCallerInfo(null);
            }, 2000);
        });

        call.on('cancel', () => {
            console.log('[SoftPhone] Call canceled');
            setCallState('ended');
            stopDurationTimer();
            setActiveCall(null);
            setIncomingCall(null);
            setIsMuted(false);
            setTimeout(() => {
                setCallState('idle');
                setCallDuration(0);
                setCallerInfo(null);
            }, 2000);
        });

        call.on('reject', () => {
            console.log('[SoftPhone] Call rejected');
            setCallState('idle');
            stopDurationTimer();
            setActiveCall(null);
            setIncomingCall(null);
            setIsMuted(false);
            setCallDuration(0);
            setCallerInfo(null);
        });

        call.on('error', (err) => {
            console.error('[SoftPhone] Call error:', err);
            setError(err.message || 'Call failed');
            setCallState('failed');
            stopDurationTimer();
            setActiveCall(null);
            setIsMuted(false);
            setTimeout(() => {
                setCallState('idle');
                setCallDuration(0);
                setCallerInfo(null);
                setError(null);
            }, 3000);
        });
    }, [startDurationTimer, stopDurationTimer]);

    // ─── Init Device ─────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;

        async function initDevice() {
            try {
                console.log('[SoftPhone] Fetching voice token...');
                const tokenResponse = await fetchVoiceToken();

                if (cancelled) return;

                // If user is not allowed to make phone calls, skip Device init
                if (tokenResponse.allowed === false) {
                    console.log('[SoftPhone] Phone calls not allowed for this user');
                    setPhoneAllowed(false);
                    return;
                }
                setPhoneAllowed(true);
                const { token } = tokenResponse;

                const dev = new Device(token, {
                    logLevel: 1,
                    codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
                });

                // Device events
                dev.on('registered', () => {
                    console.log('[SoftPhone] Device registered');
                    setDeviceReady(true);
                    setError(null);
                });

                dev.on('error', (err) => {
                    console.error('[SoftPhone] Device error:', err);
                    setError(err.message || 'Device error');
                    setDeviceReady(false);
                });

                dev.on('unregistered', () => {
                    console.log('[SoftPhone] Device unregistered');
                    setDeviceReady(false);
                });

                dev.on('tokenWillExpire', async () => {
                    console.log('[SoftPhone] Token expiring, refreshing...');
                    try {
                        const { token: newToken } = await fetchVoiceToken();
                        dev.updateToken(newToken);
                        console.log('[SoftPhone] Token refreshed');
                    } catch (err) {
                        console.error('[SoftPhone] Token refresh failed:', err);
                        setError('Token refresh failed');
                    }
                });

                // Incoming call
                dev.on('incoming', (call: Call) => {
                    console.log('[SoftPhone] Incoming call from:', call.parameters.From);
                    setIncomingCall(call);
                    setCallState('incoming');
                    setCallerInfo({ number: call.parameters.From || 'Unknown' });
                    startRingtone();

                    // Attach handlers for cancel/etc
                    call.on('cancel', () => {
                        console.log('[SoftPhone] Incoming call canceled by caller');
                        stopRingtone();
                        setIncomingCall(null);
                        setCallState('idle');
                        setCallerInfo(null);
                    });

                    call.on('disconnect', () => {
                        console.log('[SoftPhone] Incoming call disconnected');
                        setCallState('ended');
                        stopDurationTimer();
                        setActiveCall(null);
                        setIncomingCall(null);
                        setIsMuted(false);
                        setTimeout(() => {
                            setCallState('idle');
                            setCallDuration(0);
                            setCallerInfo(null);
                        }, 2000);
                    });

                    call.on('reject', () => {
                        stopRingtone();
                        setIncomingCall(null);
                        setCallState('idle');
                        setCallerInfo(null);
                    });
                });

                await dev.register();

                if (!cancelled) {
                    setDevice(dev);
                    deviceRef.current = dev;
                }
            } catch (err: any) {
                if (!cancelled) {
                    console.error('[SoftPhone] Init failed:', err);
                    setError(err.message || 'Failed to initialize SoftPhone');
                }
            }
        }

        initDevice();

        return () => {
            cancelled = true;
            stopDurationTimer();
            if (deviceRef.current) {
                deviceRef.current.destroy();
                deviceRef.current = null;
            }
        };
    }, [attachCallHandlers, stopDurationTimer]);

    // ─── Actions ─────────────────────────────────────────────────────────────
    const makeCall = useCallback(async (to: string, params?: Record<string, string>) => {
        if (!device) {
            setError('SoftPhone not ready');
            return;
        }

        setError(null);
        setCallState('connecting');
        setCallerInfo({ number: to });

        try {
            const call = await device.connect({
                params: { To: to, ...params },
            });

            setActiveCall(call);
            attachCallHandlers(call);
        } catch (err: any) {
            console.error('[SoftPhone] Connect failed:', err);
            setError(err.message || 'Failed to connect call');
            setCallState('failed');
            setTimeout(() => {
                setCallState('idle');
                setError(null);
                setCallerInfo(null);
            }, 3000);
        }
    }, [device, attachCallHandlers]);

    const acceptCall = useCallback(() => {
        if (!incomingCall) return;
        stopRingtone();

        incomingCall.accept();
        setActiveCall(incomingCall);
        setIncomingCall(null);
        setCallState('connected');
        startDurationTimer();

        // Re-attach disconnect/error handlers for accepted call
        incomingCall.on('disconnect', () => {
            setCallState('ended');
            stopDurationTimer();
            setActiveCall(null);
            setIsMuted(false);
            setTimeout(() => {
                setCallState('idle');
                setCallDuration(0);
                setCallerInfo(null);
            }, 2000);
        });

        incomingCall.on('error', (err) => {
            console.error('[SoftPhone] Accepted call error:', err);
            setError(err.message || 'Call error');
            setCallState('failed');
            stopDurationTimer();
            setActiveCall(null);
            setIsMuted(false);
            setTimeout(() => {
                setCallState('idle');
                setCallDuration(0);
                setCallerInfo(null);
                setError(null);
            }, 3000);
        });
    }, [incomingCall, startDurationTimer, stopDurationTimer]);

    const declineCall = useCallback(() => {
        if (incomingCall) {
            stopRingtone();
            incomingCall.reject();
            setIncomingCall(null);
            setCallState('idle');
            setCallerInfo(null);
        }
    }, [incomingCall]);

    const hangUp = useCallback(() => {
        if (activeCall) {
            activeCall.disconnect();
        }
        if (incomingCall) {
            incomingCall.reject();
            setIncomingCall(null);
        }
    }, [activeCall, incomingCall]);

    const toggleMute = useCallback(() => {
        if (activeCall) {
            const newMuted = !activeCall.isMuted();
            activeCall.mute(newMuted);
            setIsMuted(newMuted);
        }
    }, [activeCall]);

    const sendDigits = useCallback((digits: string) => {
        if (activeCall) {
            activeCall.sendDigits(digits);
        }
    }, [activeCall]);

    return {
        device,
        activeCall,
        incomingCall,
        callState,
        callDuration,
        callerInfo,
        makeCall,
        acceptCall,
        declineCall,
        hangUp,
        toggleMute,
        isMuted,
        sendDigits,
        deviceReady,
        error,
        phoneAllowed,
    };
}

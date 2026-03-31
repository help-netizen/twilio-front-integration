import { useState, useEffect, useRef, useCallback } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import { fetchVoiceToken } from '../services/voiceApi';
import { startRingtone, stopRingtone } from '../utils/ringtone';
import type { CallState, UseTwilioDeviceReturn } from './twilioDeviceTypes';
import { useRealtimeEvents } from './useRealtimeEvents';

export type { CallState, UseTwilioDeviceReturn };

/**
 * Pending (queued) call — an incoming call that arrived while the dispatcher
 * was already on a call.  Kept in a list so we can promote the oldest one
 * when the active call finishes.
 */
interface PendingCall {
    call: Call;
    from: string;
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
    const [pendingCount, setPendingCount] = useState(0);
    const [pendingCallerInfo, setPendingCallerInfo] = useState<{ number: string } | null>(null);
    const [holdingCallerInfo, setHoldingCallerInfo] = useState<{ number: string; callSid: string } | null>(null);

    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const connectedAtRef = useRef<number | null>(null);
    const deviceRef = useRef<Device | null>(null);
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Pending (queued) calls ref ─────────────────────────────────
    // We use a ref instead of state because the Twilio `incoming`
    // callback captures a closure at Device-init time; a ref always
    // gives us the latest value.
    const pendingCallsRef = useRef<PendingCall[]>([]);
    const syncPendingCount = useCallback(() => {
        setPendingCount(pendingCallsRef.current.length);
        const first = pendingCallsRef.current[0];
        setPendingCallerInfo(first ? { number: first.from } : null);
    }, []);

    // Busy-check ref: true when dispatcher is on an active call.
    // Updated synchronously so the `incoming` handler always sees the
    // current value even though React state is async.
    const busyRef = useRef(false);

    const startDurationTimer = useCallback(() => { connectedAtRef.current = Date.now(); durationIntervalRef.current = setInterval(() => { if (connectedAtRef.current) setCallDuration(Math.floor((Date.now() - connectedAtRef.current) / 1000)); }, 1000); }, []);
    const stopDurationTimer = useCallback(() => { if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null; } connectedAtRef.current = null; }, []);

    // ── Promote next pending call ──────────────────────────────────
    // Called after current call ends to activate the next queued call.
    const promoteNextPending = useCallback(() => {
        // Remove any calls that have already been cancelled/disconnected
        pendingCallsRef.current = pendingCallsRef.current.filter(
            pc => pc.call.status() === 'pending'
        );
        syncPendingCount();

        if (pendingCallsRef.current.length === 0) return;

        const next = pendingCallsRef.current.shift()!;
        syncPendingCount();

        console.log('[SoftPhone] Promoting pending call:', next.from);
        busyRef.current = true;
        setIncomingCall(next.call);
        setCallState('incoming');
        setCallerInfo({ number: next.from });
        startRingtone();

        // Attach handlers for the promoted call (cancel/reject by remote party)
        next.call.on('cancel', () => {
            console.log('[SoftPhone] Promoted call cancelled:', next.from);
            stopRingtone(); setIncomingCall(null); setCallerInfo(null);
            busyRef.current = false;
            if (pendingCallsRef.current.some(pc => pc.call.status() === 'pending')) {
                promoteNextPending();
            } else {
                setCallState('idle'); syncPendingCount();
            }
        });
    }, [syncPendingCount]);

    const resetToIdle = useCallback((delay: number) => {
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => {
            resetTimerRef.current = null;
            // Don't reset to idle if a pending call was promoted
            if (pendingCallsRef.current.some(pc => pc.call.status() === 'pending')) {
                promoteNextPending();
                return;
            }
            // A new incoming/outgoing call arrived while timer was pending — don't overwrite
            if (busyRef.current) return;
            setCallState('idle');
            setCallDuration(0);
            setCallerInfo(null);
            busyRef.current = false;
        }, delay);
    }, [promoteNextPending]);

    const attachCallHandlers = useCallback((call: Call) => {
        call.on('accept', () => { setCallState('connected'); startDurationTimer(); busyRef.current = true; });
        call.on('ringing', () => { setCallState('ringing'); });
        call.on('disconnect', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); busyRef.current = false; resetToIdle(2000); });
        call.on('cancel', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIncomingCall(null); setIsMuted(false); busyRef.current = false; resetToIdle(2000); });
        call.on('reject', () => { setCallState('idle'); stopDurationTimer(); setActiveCall(null); setIncomingCall(null); setIsMuted(false); setCallDuration(0); setCallerInfo(null); busyRef.current = false; });
        call.on('error', (err) => { setError(err.message || 'Call failed'); setCallState('failed'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); busyRef.current = false; setTimeout(() => { setCallState('idle'); setCallDuration(0); setCallerInfo(null); setError(null); }, 3000); });
    }, [startDurationTimer, stopDurationTimer, resetToIdle]);

    useEffect(() => {
        let cancelled = false;
        async function initDevice() {
            try {
                const tokenResponse = await fetchVoiceToken();
                if (cancelled) return;
                if (tokenResponse.allowed === false) { setPhoneAllowed(false); return; }
                setPhoneAllowed(true);
                const dev = new Device(tokenResponse.token, { logLevel: 1, codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU] });
                dev.on('registered', () => { setDeviceReady(true); setError(null); });
                dev.on('error', (err) => { setError(err.message || 'Device error'); setDeviceReady(false); });
                dev.on('unregistered', () => { setDeviceReady(false); });
                dev.on('tokenWillExpire', async () => { try { const { token: newToken } = await fetchVoiceToken(); dev.updateToken(newToken); } catch { setError('Token refresh failed'); } });

                // ── Incoming call handler (queue-aware) ────────────────────
                dev.on('incoming', (call: Call) => {
                    const from = call.parameters.From || 'Unknown';

                    // Cancel any pending resetToIdle from a previous call's disconnect
                    if (resetTimerRef.current) {
                        clearTimeout(resetTimerRef.current);
                        resetTimerRef.current = null;
                    }

                    if (busyRef.current) {
                        // Dispatcher is busy (on a call OR already ringing) → queue silently
                        console.log('[SoftPhone] Busy — queuing incoming from', from);
                        stopRingtone(); // safety: ensure no lingering ringtone
                        pendingCallsRef.current.push({ call, from });
                        syncPendingCount();
                        // Clear holdingCallerInfo since call is now in SDK pending queue
                        setHoldingCallerInfo(null);

                        // If this queued call gets cancelled while waiting,
                        // remove it from the queue
                        call.on('cancel', () => {
                            pendingCallsRef.current = pendingCallsRef.current.filter(pc => pc.call !== call);
                            syncPendingCount();
                            console.log('[SoftPhone] Queued call cancelled:', from);
                        });
                        call.on('disconnect', () => {
                            pendingCallsRef.current = pendingCallsRef.current.filter(pc => pc.call !== call);
                            syncPendingCount();
                        });
                        return;
                    }

                    // Dispatcher is free → standard incoming flow
                    // Mark as busy IMMEDIATELY so the next incoming gets queued
                    busyRef.current = true;
                    setIncomingCall(call);
                    setCallState('incoming');
                    setCallerInfo({ number: from });
                    startRingtone();
                    // Clear holdingCallerInfo since call is now in SDK incoming state
                    setHoldingCallerInfo(null);

                    call.on('cancel', () => {
                        stopRingtone(); setIncomingCall(null); setCallerInfo(null);
                        busyRef.current = false;
                        // Promote next pending if any
                        if (pendingCallsRef.current.length > 0) {
                            promoteNextPending();
                        } else {
                            setCallState('idle');
                        }
                    });
                    call.on('disconnect', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIncomingCall(null); setIsMuted(false); busyRef.current = false; resetToIdle(2000); });
                    call.on('reject', () => {
                        stopRingtone(); setIncomingCall(null); setCallerInfo(null);
                        busyRef.current = false;
                        if (pendingCallsRef.current.length > 0) {
                            promoteNextPending();
                        } else {
                            setCallState('idle');
                        }
                    });
                });

                await dev.register();
                if (!cancelled) { setDevice(dev); deviceRef.current = dev; }
            } catch (err: any) { if (!cancelled) { setError(err.message || 'Failed to initialize SoftPhone'); } }
        }
        initDevice();
        return () => { cancelled = true; stopDurationTimer(); if (resetTimerRef.current) clearTimeout(resetTimerRef.current); if (deviceRef.current) { deviceRef.current.destroy(); deviceRef.current = null; } };
    }, [attachCallHandlers, stopDurationTimer, resetToIdle, syncPendingCount]);

    // ── SSE listener: backend hold queue notifications ──────────────────
    useRealtimeEvents({
        onGenericEvent: (eventType: string, data: any) => {
            if (eventType !== 'call.holding') return;
            console.log('[SoftPhone] SSE call.holding:', data.from_number);
            setHoldingCallerInfo({ number: data.from_number, callSid: data.call_sid });
        },
    });

    const makeCall = useCallback(async (to: string, params?: Record<string, string>) => {
        if (!device) { setError('SoftPhone not ready'); return; }
        setError(null); setCallState('connecting'); setCallerInfo({ number: to }); busyRef.current = true;
        try { const call = await device.connect({ params: { To: to, ...params } }); setActiveCall(call); attachCallHandlers(call); }
        catch (err: any) { setError(err.message || 'Failed to connect call'); setCallState('failed'); busyRef.current = false; setTimeout(() => { setCallState('idle'); setError(null); setCallerInfo(null); }, 3000); }
    }, [device, attachCallHandlers]);

    const acceptCall = useCallback(() => {
        if (!incomingCall) return; stopRingtone(); incomingCall.accept(); setActiveCall(incomingCall); setIncomingCall(null); setCallState('connected'); startDurationTimer(); busyRef.current = true;
        // disconnect handler is already attached by the incoming listener — only add error
        incomingCall.on('error', (err) => { setError(err.message || 'Call error'); setCallState('failed'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); busyRef.current = false; setTimeout(() => { setCallState('idle'); setCallDuration(0); setCallerInfo(null); setError(null); }, 3000); });
    }, [incomingCall, startDurationTimer, stopDurationTimer, resetToIdle]);

    const declineCall = useCallback(() => {
        if (!incomingCall) return;
        stopRingtone(); incomingCall.reject(); setIncomingCall(null); setCallerInfo(null);
        busyRef.current = false;
        // Promote next pending call if any, otherwise go idle
        if (pendingCallsRef.current.some(pc => pc.call.status() === 'pending')) {
            promoteNextPending();
        } else {
            setCallState('idle');
        }
    }, [incomingCall, promoteNextPending]);
    const hangUp = useCallback(() => { if (activeCall) activeCall.disconnect(); if (incomingCall) { incomingCall.reject(); setIncomingCall(null); } }, [activeCall, incomingCall]);
    const toggleMute = useCallback(() => { if (activeCall) { const newMuted = !activeCall.isMuted(); activeCall.mute(newMuted); setIsMuted(newMuted); } }, [activeCall]);
    const sendDigits = useCallback((digits: string) => { if (activeCall) activeCall.sendDigits(digits); }, [activeCall]);

    return { device, activeCall, incomingCall, callState, callDuration, callerInfo, makeCall, acceptCall, declineCall, hangUp, toggleMute, isMuted, sendDigits, deviceReady, error, phoneAllowed, pendingCount, pendingCallerInfo, holdingCallerInfo };
}

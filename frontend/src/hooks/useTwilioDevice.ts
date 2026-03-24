import { useState, useEffect, useRef, useCallback } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import { fetchVoiceToken } from '../services/voiceApi';
import { startRingtone, stopRingtone } from '../utils/ringtone';
import type { CallState, UseTwilioDeviceReturn } from './twilioDeviceTypes';

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

    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const connectedAtRef = useRef<number | null>(null);
    const deviceRef = useRef<Device | null>(null);

    // ── Pending (queued) calls ref ─────────────────────────────────
    // We use a ref instead of state because the Twilio `incoming`
    // callback captures a closure at Device-init time; a ref always
    // gives us the latest value.
    const pendingCallsRef = useRef<PendingCall[]>([]);
    const syncPendingCount = useCallback(() => {
        setPendingCount(pendingCallsRef.current.length);
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
        setIncomingCall(next.call);
        setCallState('incoming');
        setCallerInfo({ number: next.from });
        startRingtone();
    }, [syncPendingCount]);

    const resetToIdle = useCallback((delay: number) => {
        setTimeout(() => {
            // Don't reset to idle if a pending call was promoted
            if (pendingCallsRef.current.some(pc => pc.call.status() === 'pending')) {
                promoteNextPending();
                return;
            }
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

                    if (busyRef.current) {
                        // Dispatcher is busy → queue silently (no ringtone)
                        console.log('[SoftPhone] Busy — queuing incoming from', from);
                        pendingCallsRef.current.push({ call, from });
                        syncPendingCount();

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
                    setIncomingCall(call);
                    setCallState('incoming');
                    setCallerInfo({ number: from });
                    startRingtone();

                    call.on('cancel', () => { stopRingtone(); setIncomingCall(null); setCallState('idle'); setCallerInfo(null); });
                    call.on('disconnect', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIncomingCall(null); setIsMuted(false); resetToIdle(2000); });
                    call.on('reject', () => { stopRingtone(); setIncomingCall(null); setCallState('idle'); setCallerInfo(null); });
                });

                await dev.register();
                if (!cancelled) { setDevice(dev); deviceRef.current = dev; }
            } catch (err: any) { if (!cancelled) { setError(err.message || 'Failed to initialize SoftPhone'); } }
        }
        initDevice();
        return () => { cancelled = true; stopDurationTimer(); if (deviceRef.current) { deviceRef.current.destroy(); deviceRef.current = null; } };
    }, [attachCallHandlers, stopDurationTimer, resetToIdle, syncPendingCount]);

    const makeCall = useCallback(async (to: string, params?: Record<string, string>) => {
        if (!device) { setError('SoftPhone not ready'); return; }
        setError(null); setCallState('connecting'); setCallerInfo({ number: to }); busyRef.current = true;
        try { const call = await device.connect({ params: { To: to, ...params } }); setActiveCall(call); attachCallHandlers(call); }
        catch (err: any) { setError(err.message || 'Failed to connect call'); setCallState('failed'); busyRef.current = false; setTimeout(() => { setCallState('idle'); setError(null); setCallerInfo(null); }, 3000); }
    }, [device, attachCallHandlers]);

    const acceptCall = useCallback(() => {
        if (!incomingCall) return; stopRingtone(); incomingCall.accept(); setActiveCall(incomingCall); setIncomingCall(null); setCallState('connected'); startDurationTimer(); busyRef.current = true;
        incomingCall.on('disconnect', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); busyRef.current = false; resetToIdle(2000); });
        incomingCall.on('error', (err) => { setError(err.message || 'Call error'); setCallState('failed'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); busyRef.current = false; setTimeout(() => { setCallState('idle'); setCallDuration(0); setCallerInfo(null); setError(null); }, 3000); });
    }, [incomingCall, startDurationTimer, stopDurationTimer, resetToIdle]);

    const declineCall = useCallback(() => { if (incomingCall) { stopRingtone(); incomingCall.reject(); setIncomingCall(null); setCallState('idle'); setCallerInfo(null); } }, [incomingCall]);
    const hangUp = useCallback(() => { if (activeCall) activeCall.disconnect(); if (incomingCall) { incomingCall.reject(); setIncomingCall(null); } }, [activeCall, incomingCall]);
    const toggleMute = useCallback(() => { if (activeCall) { const newMuted = !activeCall.isMuted(); activeCall.mute(newMuted); setIsMuted(newMuted); } }, [activeCall]);
    const sendDigits = useCallback((digits: string) => { if (activeCall) activeCall.sendDigits(digits); }, [activeCall]);

    return { device, activeCall, incomingCall, callState, callDuration, callerInfo, makeCall, acceptCall, declineCall, hangUp, toggleMute, isMuted, sendDigits, deviceReady, error, phoneAllowed, pendingCount };
}

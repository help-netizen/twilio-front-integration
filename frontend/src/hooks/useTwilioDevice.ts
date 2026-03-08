import { useState, useEffect, useRef, useCallback } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import { fetchVoiceToken } from '../services/voiceApi';
import { startRingtone, stopRingtone } from '../utils/ringtone';
import type { CallState, UseTwilioDeviceReturn } from './twilioDeviceTypes';

export type { CallState, UseTwilioDeviceReturn };

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

    const startDurationTimer = useCallback(() => { connectedAtRef.current = Date.now(); durationIntervalRef.current = setInterval(() => { if (connectedAtRef.current) setCallDuration(Math.floor((Date.now() - connectedAtRef.current) / 1000)); }, 1000); }, []);
    const stopDurationTimer = useCallback(() => { if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null; } connectedAtRef.current = null; }, []);

    const resetToIdle = useCallback((delay: number) => { setTimeout(() => { setCallState('idle'); setCallDuration(0); setCallerInfo(null); }, delay); }, []);

    const attachCallHandlers = useCallback((call: Call) => {
        call.on('accept', () => { setCallState('connected'); startDurationTimer(); });
        call.on('ringing', () => { setCallState('ringing'); });
        call.on('disconnect', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); resetToIdle(2000); });
        call.on('cancel', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIncomingCall(null); setIsMuted(false); resetToIdle(2000); });
        call.on('reject', () => { setCallState('idle'); stopDurationTimer(); setActiveCall(null); setIncomingCall(null); setIsMuted(false); setCallDuration(0); setCallerInfo(null); });
        call.on('error', (err) => { setError(err.message || 'Call failed'); setCallState('failed'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); setTimeout(() => { setCallState('idle'); setCallDuration(0); setCallerInfo(null); setError(null); }, 3000); });
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
                dev.on('incoming', (call: Call) => {
                    setIncomingCall(call); setCallState('incoming'); setCallerInfo({ number: call.parameters.From || 'Unknown' }); startRingtone();
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
    }, [attachCallHandlers, stopDurationTimer, resetToIdle]);

    const makeCall = useCallback(async (to: string, params?: Record<string, string>) => {
        if (!device) { setError('SoftPhone not ready'); return; }
        setError(null); setCallState('connecting'); setCallerInfo({ number: to });
        try { const call = await device.connect({ params: { To: to, ...params } }); setActiveCall(call); attachCallHandlers(call); }
        catch (err: any) { setError(err.message || 'Failed to connect call'); setCallState('failed'); setTimeout(() => { setCallState('idle'); setError(null); setCallerInfo(null); }, 3000); }
    }, [device, attachCallHandlers]);

    const acceptCall = useCallback(() => {
        if (!incomingCall) return; stopRingtone(); incomingCall.accept(); setActiveCall(incomingCall); setIncomingCall(null); setCallState('connected'); startDurationTimer();
        incomingCall.on('disconnect', () => { setCallState('ended'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); resetToIdle(2000); });
        incomingCall.on('error', (err) => { setError(err.message || 'Call error'); setCallState('failed'); stopDurationTimer(); setActiveCall(null); setIsMuted(false); setTimeout(() => { setCallState('idle'); setCallDuration(0); setCallerInfo(null); setError(null); }, 3000); });
    }, [incomingCall, startDurationTimer, stopDurationTimer, resetToIdle]);

    const declineCall = useCallback(() => { if (incomingCall) { stopRingtone(); incomingCall.reject(); setIncomingCall(null); setCallState('idle'); setCallerInfo(null); } }, [incomingCall]);
    const hangUp = useCallback(() => { if (activeCall) activeCall.disconnect(); if (incomingCall) { incomingCall.reject(); setIncomingCall(null); } }, [activeCall, incomingCall]);
    const toggleMute = useCallback(() => { if (activeCall) { const newMuted = !activeCall.isMuted(); activeCall.mute(newMuted); setIsMuted(newMuted); } }, [activeCall]);
    const sendDigits = useCallback((digits: string) => { if (activeCall) activeCall.sendDigits(digits); }, [activeCall]);

    return { device, activeCall, incomingCall, callState, callDuration, callerInfo, makeCall, acceptCall, declineCall, hangUp, toggleMute, isMuted, sendDigits, deviceReady, error, phoneAllowed };
}

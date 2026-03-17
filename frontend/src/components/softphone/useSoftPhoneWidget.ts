import { useState, useCallback, useEffect } from 'react';
import { type UseTwilioDeviceReturn } from '../../hooks/useTwilioDevice';
import { normalizeToE164, formatPhoneDisplay, isLikelyPhoneInput } from '../../utils/phoneUtils';
import { useSoftPhone } from '../../contexts/SoftPhoneContext';
import { authedFetch } from '../../services/apiClient';
import React from 'react';

interface BlancNumber { phone_number: string; friendly_name: string | null; }

export function useSoftPhoneWidget(voice: UseTwilioDeviceReturn, open: boolean) {
    const [inputValue, setInputValue] = useState('');
    const [normalizedNumber, setNormalizedNumber] = useState<string | null>(null);
    const [selectedContactName, setSelectedContactName] = useState<string | null>(null);
    const [showKeypad, setShowKeypad] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    const [callError, setCallError] = useState<string | null>(null);
    const [blancNumbers, setBlancNumbers] = useState<BlancNumber[]>([]);
    const [selectedCallerId, setSelectedCallerId] = useState<string>('');
    const [lastCallPhone, setLastCallPhone] = useState<string | null>(null);
    const { pendingRequest, clearPending, setActiveCallContact } = useSoftPhone();
    const { callState, callerInfo, makeCall, sendDigits } = voice;

    // Consume pending click-to-call request
    useEffect(() => {
        if (open && pendingRequest) {
            const e164 = normalizeToE164(pendingRequest.phone);
            setInputValue(formatPhoneDisplay(e164 || pendingRequest.phone));
            setNormalizedNumber(e164);
            setSelectedContactName(pendingRequest.contactName || null);
            setShowSearch(false); setCallError(null); clearPending();
        }
    }, [open, pendingRequest, clearPending]);

    // Fetch Blanc-enabled phone numbers for caller ID picker
    useEffect(() => {
        (async () => {
            try {
                const res = await authedFetch('/api/voice/blanc-numbers');
                const data = await res.json();
                if (data.ok && data.numbers.length > 0) { setBlancNumbers(data.numbers); setSelectedCallerId(data.numbers[0].phone_number); }
            } catch (err) { console.error('[SoftPhone] Failed to load blanc numbers:', err); }
        })();
    }, []);

    // Reset contact name on call transitions
    useEffect(() => {
        if (callState === 'incoming') { const p = callerInfo?.number || null; if (p !== lastCallPhone) { setSelectedContactName(null); setLastCallPhone(p); } }
        else if (callState === 'idle') { setSelectedContactName(null); setLastCallPhone(null); }
    }, [callState, callerInfo?.number]); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-resolve contact name
    useEffect(() => {
        if (callState === 'idle' || selectedContactName) return;
        const phone = callerInfo?.number || normalizedNumber;
        if (!phone) return;
        authedFetch(`/api/pulse/timeline-by-phone?phone=${encodeURIComponent(phone)}`).then(r => r.json()).then(d => { if (d.contactName && !selectedContactName) setSelectedContactName(d.contactName); }).catch(() => { });
    }, [callState, callerInfo?.number, normalizedNumber, selectedContactName]);

    // Sync active call contact name to context
    useEffect(() => {
        const isIn = ['connecting', 'ringing', 'connected', 'incoming'].includes(callState);
        if (isIn) { const phone = callerInfo?.number || normalizedNumber; setActiveCallContact(selectedContactName || (phone ? formatPhoneDisplay(phone) : null)); }
        else setActiveCallContact(null);
    }, [callState, selectedContactName, callerInfo?.number, normalizedNumber, setActiveCallContact]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value; setInputValue(val); setSelectedContactName(null);
        if (isLikelyPhoneInput(val)) setNormalizedNumber(normalizeToE164(val)); else setNormalizedNumber(null);
        setShowSearch(val.trim().length >= 2);
    };

    const handleContactSelect = useCallback((e164: string, displayName: string, displayPhone: string) => {
        setInputValue(displayPhone); setNormalizedNumber(e164); setSelectedContactName(displayName); setShowSearch(false);
    }, []);

    const handleCall = useCallback(async () => {
        if (!normalizedNumber) return; setCallError(null);
        try { const res = await authedFetch(`/api/voice/check-busy?phone=${encodeURIComponent(normalizedNumber)}`); const data = await res.json(); if (data.busy) { setCallError(data.message || 'A team member is already on the line with this contact.'); setTimeout(() => setCallError(null), 5000); return; } } catch { }
        const params: Record<string, string> = {}; if (selectedCallerId) params.CallerId = selectedCallerId;
        makeCall(normalizedNumber, params); setShowSearch(false);
    }, [normalizedNumber, makeCall, selectedCallerId]);

    const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && normalizedNumber && callState === 'idle') handleCall(); if (e.key === 'Escape') setShowSearch(false); };
    const handleDtmf = (digit: string) => { sendDigits(digit); };

    return {
        inputValue, normalizedNumber, selectedContactName, showKeypad, setShowKeypad, showSearch, callError, blancNumbers, selectedCallerId, setSelectedCallerId,
        handleInputChange, handleContactSelect, handleCall, handleKeyDown, handleDtmf, setShowSearch,
    };
}

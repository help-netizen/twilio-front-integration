/**
 * SoftPhoneWidget — Main SoftPhone modal component.
 *
 * Unified dial/search input with state-based call UI.
 * Uses useTwilioDevice hook for call management.
 */

import React, { useState, useCallback } from 'react';
import { Phone, PhoneOff, PhoneIncoming, X, Mic, MicOff, Grid3x3 } from 'lucide-react';
import { type UseTwilioDeviceReturn } from '../../hooks/useTwilioDevice';
import { ContactSearchDropdown } from './ContactSearchDropdown';
import { normalizeToE164, formatPhoneDisplay, isLikelyPhoneInput } from '../../utils/phoneUtils';
import './SoftPhoneWidget.css';

interface SoftPhoneWidgetProps {
    voice: UseTwilioDeviceReturn;
    open: boolean;
    onClose: () => void;
}

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export const SoftPhoneWidget: React.FC<SoftPhoneWidgetProps> = ({ voice, open, onClose }) => {
    const [inputValue, setInputValue] = useState('');
    const [normalizedNumber, setNormalizedNumber] = useState<string | null>(null);
    const [selectedContactName, setSelectedContactName] = useState<string | null>(null);
    const [showKeypad, setShowKeypad] = useState(false);
    const [showSearch, setShowSearch] = useState(false);

    const {
        callState,
        callDuration,
        callerInfo,
        deviceReady,
        error,
        isMuted,
        makeCall,
        acceptCall,
        declineCall,
        hangUp,
        toggleMute,
        sendDigits,
    } = voice;

    // Format duration as mm:ss
    const formatDuration = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // Handle input change — decide dial vs search mode
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setInputValue(val);
        setSelectedContactName(null);

        if (isLikelyPhoneInput(val)) {
            const normalized = normalizeToE164(val);
            setNormalizedNumber(normalized);
            setShowSearch(false);
        } else {
            setNormalizedNumber(null);
            setShowSearch(val.trim().length >= 2);
        }
    };

    // Contact selected from search
    const handleContactSelect = useCallback((e164: string, displayName: string, displayPhone: string) => {
        setInputValue(displayPhone);
        setNormalizedNumber(e164);
        setSelectedContactName(displayName);
        setShowSearch(false);
    }, []);

    // Initiate outbound call
    const handleCall = useCallback(() => {
        if (!normalizedNumber) return;
        makeCall(normalizedNumber);
        setShowSearch(false);
    }, [normalizedNumber, makeCall]);

    // Handle Enter key
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && normalizedNumber && callState === 'idle') {
            handleCall();
        }
        if (e.key === 'Escape') {
            setShowSearch(false);
        }
    };

    // DTMF key press
    const handleDtmf = (digit: string) => {
        sendDigits(digit);
    };

    if (!open) return null;

    const isInCall = ['connecting', 'ringing', 'connected', 'incoming'].includes(callState);
    const canCall = normalizedNumber && callState === 'idle' && deviceReady;

    // Status label and class
    const statusConfig: Record<string, { label: string; className: string }> = {
        idle: { label: 'Phone service connected', className: '' },
        connecting: { label: 'Connecting...', className: 'connecting' },
        ringing: { label: 'Ringing...', className: 'ringing' },
        incoming: { label: 'Incoming Call', className: 'incoming' },
        connected: { label: `Connected — ${formatDuration(callDuration)}`, className: 'connected' },
        ended: { label: 'Call Ended', className: 'ended' },
        failed: { label: 'Call Failed', className: 'failed' },
    };

    const status = statusConfig[callState] || statusConfig.idle;

    return (
        <div className="softphone-overlay" onClick={(e) => { if (e.target === e.currentTarget && !isInCall) onClose(); }}>
            <div className="softphone-modal">
                {/* Header */}
                <div className="softphone-header">
                    <div className="softphone-header-title">
                        <span className={`softphone-status-dot ${deviceReady ? '' : 'offline'}`} />
                        SoftPhone
                    </div>
                    {!isInCall && (
                        <button className="softphone-close" onClick={onClose}>
                            <X size={18} />
                        </button>
                    )}
                </div>

                <div className="softphone-body">
                    {/* ─── Idle State ──────────────────────────────────────────── */}
                    {callState === 'idle' && (
                        <>
                            <div className="softphone-input-wrapper">
                                <input
                                    className="softphone-input"
                                    type="text"
                                    placeholder="Enter phone number or search contact..."
                                    value={inputValue}
                                    onChange={handleInputChange}
                                    onKeyDown={handleKeyDown}
                                    onFocus={() => {
                                        if (!isLikelyPhoneInput(inputValue) && inputValue.trim().length >= 2) {
                                            setShowSearch(true);
                                        }
                                    }}
                                    autoFocus
                                />
                                <ContactSearchDropdown
                                    query={inputValue}
                                    onSelect={handleContactSelect}
                                    visible={showSearch}
                                />
                            </div>

                            {selectedContactName && (
                                <div className="softphone-helper">
                                    {selectedContactName} — {formatPhoneDisplay(normalizedNumber || '')}
                                </div>
                            )}

                            {!normalizedNumber && inputValue.length > 0 && isLikelyPhoneInput(inputValue) && (
                                <div className="softphone-helper error">
                                    Enter a valid phone number (e.g., 617-555-1234 or +16175551234)
                                </div>
                            )}

                            <div className="softphone-actions">
                                <button
                                    className="softphone-btn softphone-btn-call"
                                    onClick={handleCall}
                                    disabled={!canCall}
                                >
                                    <Phone size={18} />
                                    Call
                                </button>
                            </div>
                        </>
                    )}

                    {/* ─── Incoming Call State ────────────────────────────────── */}
                    {callState === 'incoming' && (
                        <>
                            <div className="softphone-call-info">
                                <div className="softphone-call-number">
                                    {callerInfo?.number ? formatPhoneDisplay(callerInfo.number) : 'Unknown'}
                                </div>
                                {callerInfo?.contactName && (
                                    <div className="softphone-call-name">{callerInfo.contactName}</div>
                                )}
                                <div className={`softphone-call-status ${status.className}`}>
                                    <PhoneIncoming size={16} />
                                    {status.label}
                                </div>
                            </div>
                            <div className="softphone-actions">
                                <button className="softphone-btn softphone-btn-accept" onClick={acceptCall}>
                                    <Phone size={18} />
                                    Accept
                                </button>
                                <button className="softphone-btn softphone-btn-decline" onClick={declineCall}>
                                    <PhoneOff size={18} />
                                    Decline
                                </button>
                            </div>
                        </>
                    )}

                    {/* ─── In-Call States (connecting/ringing/connected) ──────── */}
                    {['connecting', 'ringing', 'connected'].includes(callState) && (
                        <>
                            <div className="softphone-call-info">
                                <div className="softphone-call-number">
                                    {callerInfo?.number ? formatPhoneDisplay(callerInfo.number) : inputValue}
                                </div>
                                {(selectedContactName || callerInfo?.contactName) && (
                                    <div className="softphone-call-name">
                                        {selectedContactName || callerInfo?.contactName}
                                    </div>
                                )}
                                <div className={`softphone-call-status ${status.className}`}>
                                    <span className="softphone-call-timer">{status.label}</span>
                                </div>
                            </div>

                            {/* Secondary controls (connected only) */}
                            {callState === 'connected' && (
                                <div className="softphone-controls-row">
                                    <button
                                        className={`softphone-btn softphone-btn-secondary ${isMuted ? 'active' : ''}`}
                                        onClick={toggleMute}
                                        title={isMuted ? 'Unmute' : 'Mute'}
                                    >
                                        {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                                    </button>
                                    <button
                                        className={`softphone-btn softphone-btn-secondary ${showKeypad ? 'active' : ''}`}
                                        onClick={() => setShowKeypad(!showKeypad)}
                                        title="Keypad"
                                    >
                                        <Grid3x3 size={18} />
                                    </button>
                                </div>
                            )}

                            {/* DTMF Keypad */}
                            {showKeypad && callState === 'connected' && (
                                <div className="softphone-keypad">
                                    {DTMF_KEYS.map((key) => (
                                        <button
                                            key={key}
                                            className="softphone-keypad-btn"
                                            onClick={() => handleDtmf(key)}
                                        >
                                            {key}
                                        </button>
                                    ))}
                                </div>
                            )}

                            <div className="softphone-actions">
                                <button className="softphone-btn softphone-btn-end" onClick={hangUp}>
                                    <PhoneOff size={18} />
                                    End Call
                                </button>
                            </div>
                        </>
                    )}

                    {/* ─── Ended / Failed States ──────────────────────────────── */}
                    {['ended', 'failed'].includes(callState) && (
                        <div className="softphone-call-info">
                            <div className={`softphone-call-status ${status.className}`}>
                                {status.label}
                            </div>
                        </div>
                    )}

                    {/* ─── Error Banner ────────────────────────────────────────── */}
                    {error && (
                        <div className="softphone-error">{error}</div>
                    )}
                </div>
            </div>
        </div>
    );
};

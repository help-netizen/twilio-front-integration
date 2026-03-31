/**
 * SoftPhoneWidget — Main SoftPhone panel component.
 * Unified dial/search input with state-based call UI.
 */
import React from 'react';
import { Phone, PhoneOff, PhoneIncoming, X, Mic, MicOff, Grid3x3, Minimize2 } from 'lucide-react';
import { type UseTwilioDeviceReturn } from '../../hooks/useTwilioDevice';
import { ContactSearchDropdown } from './ContactSearchDropdown';
import { formatPhoneDisplay } from '../../utils/phoneUtils';
import { useSoftPhoneWidget } from './useSoftPhoneWidget';
import './SoftPhoneWidget.css';

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

interface SoftPhoneWidgetProps { voice: UseTwilioDeviceReturn; open: boolean; minimized: boolean; onClose: () => void; onMinimize: () => void; }

export const SoftPhoneWidget: React.FC<SoftPhoneWidgetProps> = ({ voice, open, minimized, onClose, onMinimize }) => {
    const { inputValue, normalizedNumber, selectedContactName, showKeypad, setShowKeypad, showSearch, callError, blancNumbers, selectedCallerId, setSelectedCallerId, handleInputChange, handleContactSelect, handleCall, handleKeyDown, handleDtmf, setShowSearch } = useSoftPhoneWidget(voice, open);
    const { callState, callDuration, callerInfo, deviceReady, error, isMuted, acceptCall, declineCall, hangUp, toggleMute, pendingCount, pendingCallerInfo, holdingCallerInfo } = voice;

    const formatDuration = (seconds: number) => { const m = Math.floor(seconds / 60); const s = seconds % 60; return `${m}:${s.toString().padStart(2, '0')}`; };

    if (!open || minimized) return null;

    const isInCall = ['connecting', 'ringing', 'connected', 'incoming'].includes(callState);
    const canCall = normalizedNumber && callState === 'idle' && deviceReady;
    const statusConfig: Record<string, { label: string; className: string }> = {
        idle: { label: 'Phone service connected', className: '' }, connecting: { label: 'Connecting...', className: 'connecting' }, ringing: { label: 'Ringing...', className: 'ringing' }, incoming: { label: 'Incoming Call', className: 'incoming' }, connected: { label: `Connected — ${formatDuration(callDuration)}`, className: 'connected' }, ended: { label: 'Call Ended', className: 'ended' }, failed: { label: 'Call Failed', className: 'failed' },
    };
    const status = statusConfig[callState] || statusConfig.idle;

    // Determine waiting call info: SDK pending > SSE holding
    const waitingNumber = pendingCallerInfo?.number || holdingCallerInfo?.number || null;
    const hasWaitingCall = pendingCount > 0 || !!holdingCallerInfo;

    return (
        <div className="softphone-panel">
            <div className="softphone-header">
                <div className="softphone-header-title">
                    <span className={`softphone-status-dot ${deviceReady ? '' : 'offline'}`} />
                    {blancNumbers.length > 0 ? (
                        <div className="softphone-header-caller-id"><span className="softphone-header-caller-label">Call from:</span><select className="softphone-header-caller-select" value={selectedCallerId} onChange={e => setSelectedCallerId(e.target.value)}>{blancNumbers.map(n => <option key={n.phone_number} value={n.phone_number}>{formatPhoneDisplay(n.phone_number)}</option>)}</select></div>
                    ) : <span>SoftPhone</span>}
                </div>
                <div className="softphone-header-actions">
                    {isInCall && <button className="softphone-header-btn" onClick={onMinimize} title="Minimize"><Minimize2 size={16} /></button>}
                    {!isInCall && <button className="softphone-header-btn" onClick={onClose} title="Close"><X size={16} /></button>}
                </div>
            </div>
            <div className="softphone-body">
                {callState === 'idle' && (<>
                    <div className="softphone-input-wrapper"><input className="softphone-input" type="text" placeholder="Enter phone number or search contact..." value={inputValue} onChange={handleInputChange} onKeyDown={handleKeyDown} onFocus={() => { if (inputValue.trim().length >= 2) setShowSearch(true); }} autoFocus /><ContactSearchDropdown query={inputValue} onSelect={handleContactSelect} visible={showSearch} /></div>
                    <div className="softphone-contact-name-slot">{selectedContactName && <span>{selectedContactName} — {formatPhoneDisplay(normalizedNumber || '')}</span>}</div>
                    {callError && <div className="softphone-error">{callError}</div>}
                    <div className="softphone-actions"><button className="softphone-btn softphone-btn-call" onClick={handleCall} disabled={!canCall}><Phone size={18} />Call</button></div>
                </>)}
                {callState === 'incoming' && (<>
                    <div className="softphone-call-info"><div className="softphone-call-number">{callerInfo?.number ? formatPhoneDisplay(callerInfo.number) : 'Unknown'}</div>{selectedContactName && <div className="softphone-call-name">{selectedContactName}</div>}<div className={`softphone-call-status ${status.className}`}><PhoneIncoming size={16} />{status.label}</div></div>
                    <div className="softphone-actions"><button className="softphone-btn softphone-btn-accept" onClick={acceptCall}><Phone size={18} />Accept</button><button className="softphone-btn softphone-btn-decline" onClick={declineCall}><PhoneOff size={18} />Decline</button></div>
                </>)}
                {['connecting', 'ringing', 'connected'].includes(callState) && (<>
                    <div className="softphone-call-info"><div className="softphone-call-number">{callerInfo?.number ? formatPhoneDisplay(callerInfo.number) : inputValue}</div>{(selectedContactName || callerInfo?.contactName) && <div className="softphone-call-name">{selectedContactName || callerInfo?.contactName}</div>}<div className={`softphone-call-status ${status.className}`}><span className="softphone-call-timer">{status.label}</span></div></div>
                    {callState === 'connected' && <div className="softphone-controls-row"><button className={`softphone-btn softphone-btn-secondary ${isMuted ? 'active' : ''}`} onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>{isMuted ? <MicOff size={18} /> : <Mic size={18} />}</button><button className={`softphone-btn softphone-btn-secondary ${showKeypad ? 'active' : ''}`} onClick={() => setShowKeypad(!showKeypad)} title="Keypad"><Grid3x3 size={18} /></button></div>}
                    {showKeypad && callState === 'connected' && <div className="softphone-keypad">{DTMF_KEYS.map(key => <button key={key} className="softphone-keypad-btn" onClick={() => handleDtmf(key)}>{key}</button>)}</div>}
                    <div className="softphone-actions"><button className="softphone-btn softphone-btn-end" onClick={hangUp}><PhoneOff size={18} />End Call</button></div>
                    {hasWaitingCall && <div className="softphone-pending-banner"><PhoneIncoming size={14} /><span>Call waiting{waitingNumber ? `: ${formatPhoneDisplay(waitingNumber)}` : ''}</span></div>}
                </>)}
                {['ended', 'failed'].includes(callState) && <div className="softphone-call-info"><div className={`softphone-call-status ${status.className}`}>{status.label}</div></div>}
                {error && <div className="softphone-error">{error}</div>}
            </div>
        </div>
    );
};

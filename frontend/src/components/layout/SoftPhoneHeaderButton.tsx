import { Phone, PhoneIncoming, Mic, MicOff } from 'lucide-react';
import { useSoftPhone } from '../../contexts/SoftPhoneContext';
import { formatPhoneDisplay } from '../../utils/phoneUtils';
import type { useTwilioDevice } from '../../hooks/useTwilioDevice';

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
    voice: ReturnType<typeof useTwilioDevice>;
    softPhoneOpen: boolean;
    softPhoneMinimized: boolean;
    onOpenOrRestore: () => void;
    onAcceptIncoming?: () => void;
    incomingCallerName?: string | null;
}

export function SoftPhoneHeaderButton({ voice, softPhoneOpen, softPhoneMinimized, onOpenOrRestore, onAcceptIncoming, incomingCallerName }: Props) {
    const { activeCallContact } = useSoftPhone();
    const { callState, callDuration, isMuted, toggleMute } = voice;

    const isInCall = ['connecting', 'ringing', 'connected', 'incoming'].includes(callState);
    const showCallState = isInCall || callState === 'ended' || callState === 'failed';

    if (softPhoneOpen && !softPhoneMinimized) {
        return <button onClick={onOpenOrRestore} className="softphone-header-btn" title="SoftPhone is open"><Phone size={15} /><span>SoftPhone</span></button>;
    }

    if (showCallState) {
        if (callState === 'incoming') {
            const callerDisplay = incomingCallerName || activeCallContact || (voice.callerInfo?.number ? formatPhoneDisplay(voice.callerInfo.number) : 'Unknown');
            return <button onClick={onAcceptIncoming || onOpenOrRestore} className="softphone-header-btn active-incoming" title="Click to accept incoming call"><PhoneIncoming size={14} /><span className="softphone-header-contact">{callerDisplay}</span><span className="softphone-header-status">— Accept</span></button>;
        }

        const statusClass = callState === 'connected' ? 'active-connected' : callState === 'connecting' || callState === 'ringing' ? 'active-ringing' : callState === 'ended' ? 'active-ended' : callState === 'failed' ? 'active-failed' : '';
        const statusLabel = callState === 'connected' ? formatDuration(callDuration) : callState === 'connecting' ? 'Connecting...' : callState === 'ringing' ? 'Ringing...' : callState === 'ended' ? 'Call Ended' : callState === 'failed' ? 'Call Failed' : '';

        return (
            <button onClick={onOpenOrRestore} className={`softphone-header-btn ${statusClass}`} title="Click to restore SoftPhone">
                <Phone size={14} />
                {activeCallContact && <span className="softphone-header-contact">{activeCallContact}</span>}
                <span className="softphone-header-status">{statusLabel}</span>
                {isInCall && <span className={`softphone-header-mute ${isMuted ? 'muted' : ''}`} onClick={(e) => { e.stopPropagation(); toggleMute(); }} title={isMuted ? 'Unmute' : 'Mute'}>{isMuted ? <MicOff size={13} /> : <Mic size={13} />}</span>}
            </button>
        );
    }

    return <button onClick={onOpenOrRestore} className="softphone-header-btn" title="Open SoftPhone"><Phone size={15} /><span>SoftPhone</span></button>;
}

import type { CallFlowNodeKind } from '../../types/telephony';

/**
 * Default config values for each node kind when inserted via the palette.
 * Matches the config_schema defaults from the requirements spec.
 */
export const NODE_DEFAULTS: Partial<Record<CallFlowNodeKind, Record<string, unknown>>> = {
    greeting: {
        mode: 'tts',
        text: '',
        voice_provider: 'twilio_basic',
        voice_key: 'man',
        language_code: 'en-US',
        loop_count: 1,
    },
    queue: {
        target_mode: 'current_group',
        queue_mode: 'queue_pull',
        max_wait_sec: 120,
        wait_url_mode: 'provider_generated',
        on_timeout: 'edge',
        expose_queue_context_in_pulse: true,
        expose_queue_context_in_softphone: true,
        allow_manual_connect: true,
    },
    branch: {
        branch_mode: 'custom_conditions',
        short_circuit_evaluation: true,
        conditions: [
            { id: 'cond-1', label: 'Condition 1', kind: 'schedule_open', config: {}, order: 0 },
            { id: 'else-1', label: 'Else', kind: 'else', config: {}, order: 1 },
        ],
    },
    transfer: {
        target_type: 'phone_number_group',
        group_handoff_mode: 'enter_group_queue',
        user_target_preference: 'sdk_first_then_external',
        timeout_sec: 20,
        caller_id_policy: 'preserve_called_number',
        on_fail: 'edge',
    },
    voicemail: {
        mailbox_mode: 'current_group_default',
        greeting_mode: 'inherit_from_group',
        max_length_sec: 120,
        finish_on_key: '#',
        play_beep: true,
        trim_silence: true,
        transcription_enabled: true,
        send_recording_event_to_timeline: true,
    },
    hangup: {
        reason_code: 'admin_defined',
        optional_message_mode: 'none',
    },
    play_audio: {
        source: 'audio_library',
        playback_count: 1,
        fallback_mode: 'skip_node',
        stop_if_call_disconnected: true,
    },
};

/** Whether a node kind is terminal in UI (no outgoing edge editing) */
export const TERMINAL_KINDS = new Set<CallFlowNodeKind>(['voicemail', 'hangup']);

/** Whether a node kind is disabled in the palette */
export const DISABLED_KINDS = new Set<CallFlowNodeKind>(['collect_input', 'menu']);

/** Locked/out-of-scope kinds */
export const LOCKED_KINDS = new Set<CallFlowNodeKind>(['vapi_agent']);

/** Palette display order (enabled first, disabled last) */
export const PALETTE_ORDER: CallFlowNodeKind[] = [
    // Enabled
    'greeting', 'queue', 'branch', 'transfer', 'voicemail', 'hangup', 'play_audio',
    // Disabled
    'collect_input', 'menu',
    // Locked
    'vapi_agent',
];

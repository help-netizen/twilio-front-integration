import type { CallFlowNodeKind } from '../../types/telephony';

// ── Shared styles ────────────────────────────────────────────────────────────
const fieldStyle = { width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' as const } as const;
const labelStyle = { fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 } as const;
const row = { marginBottom: 8 } as const;
const splitRow = { display: 'flex', gap: 8, marginBottom: 8 } as const;
const checkLabel = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#374151', marginBottom: 4, cursor: 'pointer' } as const;

type InspectorProps = {
    cfg: Record<string, unknown>;
    updateCfg: (key: string, val: unknown) => void;
    isProtected?: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════════
// GREETING
// ═══════════════════════════════════════════════════════════════════════════════
export function GreetingInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    return (<>
        <div style={row}>
            <label style={labelStyle}>Text <span style={{ color: '#ef4444' }}>*</span></label>
            <textarea value={String(cfg.text || '')} onChange={e => updateCfg('text', e.target.value)}
                rows={3} style={{ ...fieldStyle, resize: 'vertical' }} disabled={isProtected}
                placeholder="Enter greeting text…" />
        </div>
        <div style={splitRow}>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Voice Provider</label>
                <select value={String(cfg.voice_provider || 'twilio_basic')} onChange={e => updateCfg('voice_provider', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="twilio_basic">Twilio Basic</option>
                    <option value="amazon_polly">Amazon Polly</option>
                    <option value="google">Google</option>
                </select>
            </div>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Voice</label>
                <select value={String(cfg.voice_key || 'man')} onChange={e => updateCfg('voice_key', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="man">Man</option>
                    <option value="woman">Woman</option>
                    <option value="Polly.Joanna">Polly.Joanna</option>
                    <option value="Polly.Matthew">Polly.Matthew</option>
                    <option value="Polly.Amy">Polly.Amy</option>
                </select>
            </div>
        </div>
        <div style={splitRow}>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Language</label>
                <select value={String(cfg.language_code || 'en-US')} onChange={e => updateCfg('language_code', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="en-US">English (US)</option>
                    <option value="en-GB">English (UK)</option>
                    <option value="es-US">Spanish (US)</option>
                    <option value="es-ES">Spanish (ES)</option>
                    <option value="fr-FR">French</option>
                    <option value="de-DE">German</option>
                </select>
            </div>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Repeat</label>
                <input type="number" min={1} max={10} value={Number(cfg.loop_count || 1)}
                    onChange={e => updateCfg('loop_count', parseInt(e.target.value) || 1)}
                    style={fieldStyle} disabled={isProtected} />
            </div>
        </div>
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUE
// ═══════════════════════════════════════════════════════════════════════════════
export function QueueInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    return (<>
        <div style={row}>
            <label style={labelStyle}>Target</label>
            <select value={String(cfg.target_mode || 'current_group')} onChange={e => updateCfg('target_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="current_group">Current Group</option>
                <option value="user_group">Specific User Group</option>
            </select>
        </div>
        {cfg.target_mode === 'user_group' && (
            <div style={row}>
                <label style={labelStyle}>User Group ID <span style={{ color: '#ef4444' }}>*</span></label>
                <input value={String(cfg.user_group_id || '')} onChange={e => updateCfg('user_group_id', e.target.value)} style={fieldStyle} placeholder="ug-…" />
            </div>
        )}
        <div style={row}>
            <label style={labelStyle}>Queue Mode</label>
            <select value={String(cfg.queue_mode || 'queue_pull')} onChange={e => updateCfg('queue_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="queue_pull">Queue Pull</option>
                <option value="auto_offer">Auto Offer</option>
            </select>
        </div>
        <div style={splitRow}>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Max Wait (sec)</label>
                <input type="number" min={5} max={3600} value={Number(cfg.max_wait_sec || 120)}
                    onChange={e => updateCfg('max_wait_sec', parseInt(e.target.value) || 120)}
                    style={fieldStyle} disabled={isProtected} />
            </div>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Hold Audio</label>
                <select value={String(cfg.wait_url_mode || 'provider_generated')} onChange={e => updateCfg('wait_url_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="provider_generated">Default</option>
                    <option value="custom_audio_asset">Custom Audio</option>
                </select>
            </div>
        </div>
        <div style={row}>
            <label style={labelStyle}>On Timeout</label>
            <select value={String(cfg.on_timeout || 'edge')} onChange={e => updateCfg('on_timeout', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="edge">Follow edge</option>
                <option value="voicemail_terminal">Go to voicemail</option>
                <option value="hangup_terminal">Hang up</option>
            </select>
        </div>
        <div style={{ marginTop: 8 }}>
            <label style={checkLabel}><input type="checkbox" checked={cfg.expose_queue_context_in_pulse !== false} onChange={e => updateCfg('expose_queue_context_in_pulse', e.target.checked)} style={{ accentColor: '#f59e0b' }} />Show in Pulse</label>
            <label style={checkLabel}><input type="checkbox" checked={cfg.expose_queue_context_in_softphone !== false} onChange={e => updateCfg('expose_queue_context_in_softphone', e.target.checked)} style={{ accentColor: '#f59e0b' }} />Show in Softphone</label>
            <label style={checkLabel}><input type="checkbox" checked={cfg.allow_manual_connect !== false} onChange={e => updateCfg('allow_manual_connect', e.target.checked)} style={{ accentColor: '#f59e0b' }} />Allow manual connect</label>
        </div>
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BRANCH
// ═══════════════════════════════════════════════════════════════════════════════
const BRANCH_CONDITION_KINDS = [
    { value: 'schedule_open', label: 'Schedule Open' },
    { value: 'caller_number_equals', label: 'Caller Number Equals' },
    { value: 'caller_number_in_list', label: 'Caller Number In List' },
    { value: 'called_number_equals', label: 'Called Number Equals' },
    { value: 'contact_exists', label: 'Contact Exists' },
    { value: 'contact_has_tag', label: 'Contact Has Tag' },
    { value: 'phone_number_group_is', label: 'Phone Number Group Is' },
    { value: 'day_of_week_in', label: 'Day of Week In' },
    { value: 'time_between_local', label: 'Time Between (Local)' },
] as const;

export function BranchInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    const conditions = (cfg.conditions as { id: string; label: string; kind: string; config: Record<string, unknown>; order: number }[] | undefined) || [];
    const nonElse = conditions.filter(c => c.kind !== 'else');
    const elseRow = conditions.find(c => c.kind === 'else');

    const updateConditions = (newConds: typeof conditions) => {
        updateCfg('conditions', newConds);
    };

    const addCondition = () => {
        if (conditions.length >= 10) return;
        const id = `cond-${Date.now()}`;
        const order = nonElse.length;
        const newCond = { id, label: `Condition ${order + 1}`, kind: 'schedule_open', config: {}, order };
        // Insert before else
        const updated = [...nonElse, newCond, ...(elseRow ? [{ ...elseRow, order: order + 1 }] : [])];
        updateConditions(updated);
    };

    const removeCondition = (id: string) => {
        const filtered = conditions.filter(c => c.id !== id);
        // Reorder
        const reordered = filtered.map((c, i) => ({ ...c, order: i }));
        updateConditions(reordered);
    };

    const updateCondField = (id: string, field: string, val: unknown) => {
        updateConditions(conditions.map(c => c.id === id ? { ...c, [field]: val } : c));
    };

    return (<>
        <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 8 }}>
            {nonElse.length} condition{nonElse.length !== 1 ? 's' : ''} + else • max 10
        </div>
        {nonElse.map((c, i) => (
            <div key={c.id} style={{ padding: '6px 8px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280' }}>#{i + 1}</span>
                    {!isProtected && (
                        <button onClick={() => removeCondition(c.id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 11, padding: 0 }}>✕</button>
                    )}
                </div>
                <div style={splitRow}>
                    <div style={{ flex: 1 }}>
                        <label style={{ ...labelStyle, fontSize: 10 }}>Type</label>
                        <select value={c.kind} onChange={e => updateCondField(c.id, 'kind', e.target.value)} style={{ ...fieldStyle, fontSize: 11 }} disabled={isProtected}>
                            {BRANCH_CONDITION_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                        </select>
                    </div>
                    <div style={{ flex: 1 }}>
                        <label style={{ ...labelStyle, fontSize: 10 }}>Label</label>
                        <input value={c.label} onChange={e => updateCondField(c.id, 'label', e.target.value)} style={{ ...fieldStyle, fontSize: 11 }} disabled={isProtected} />
                    </div>
                </div>
            </div>
        ))}
        {/* Else row — always last, pinned */}
        {elseRow && (
            <div style={{ padding: '6px 8px', background: '#fefce8', border: '1px solid #fde68a', borderRadius: 6, marginBottom: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#92400e' }}>Else (default fallback) — always last</div>
            </div>
        )}
        {!isProtected && conditions.length < 10 && (
            <button onClick={addCondition}
                style={{ width: '100%', padding: '6px 0', fontSize: 11, fontWeight: 500, background: '#f3f4f6', border: '1px dashed #d1d5db', borderRadius: 6, cursor: 'pointer', color: '#6366f1', marginTop: 4 }}>
                + Add Condition
            </button>
        )}
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER
// ═══════════════════════════════════════════════════════════════════════════════
export function TransferInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    return (<>
        <div style={row}>
            <label style={labelStyle}>Target Type</label>
            <select value={String(cfg.target_type || 'phone_number_group')} onChange={e => updateCfg('target_type', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="phone_number_group">Phone Number Group</option>
                <option value="user">Specific User</option>
                <option value="external_number">External Number</option>
            </select>
        </div>
        {cfg.target_type === 'phone_number_group' && (
            <div style={row}>
                <label style={labelStyle}>Target Group ID</label>
                <input value={String(cfg.target_group_id || '')} onChange={e => updateCfg('target_group_id', e.target.value)} style={fieldStyle} placeholder="ug-…" />
            </div>
        )}
        {cfg.target_type === 'user' && (
            <div style={row}>
                <label style={labelStyle}>Target User ID</label>
                <input value={String(cfg.target_user_id || '')} onChange={e => updateCfg('target_user_id', e.target.value)} style={fieldStyle} placeholder="User UUID" />
            </div>
        )}
        {cfg.target_type === 'external_number' && (
            <div style={row}>
                <label style={labelStyle}>External Number <span style={{ color: '#ef4444' }}>*</span></label>
                <input value={String(cfg.target_external_number || '')} onChange={e => updateCfg('target_external_number', e.target.value)} style={fieldStyle} placeholder="+1…" />
            </div>
        )}
        {cfg.target_type === 'phone_number_group' && (
            <div style={row}>
                <label style={labelStyle}>Group Handoff Mode</label>
                <select value={String(cfg.group_handoff_mode || 'enter_group_queue')} onChange={e => updateCfg('group_handoff_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="enter_group_queue">Enter group queue</option>
                    <option value="execute_group_flow">Execute group flow ⚠️</option>
                </select>
                {cfg.group_handoff_mode === 'execute_group_flow' && (
                    <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 2 }}>⚠ May replay greeting/hours logic</div>
                )}
            </div>
        )}
        {cfg.target_type === 'user' && (
            <div style={row}>
                <label style={labelStyle}>User Target Preference</label>
                <select value={String(cfg.user_target_preference || 'sdk_first_then_external')} onChange={e => updateCfg('user_target_preference', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="sdk_first_then_external">SDK first, then external</option>
                    <option value="sdk_only">SDK only</option>
                    <option value="external_only">External only</option>
                </select>
            </div>
        )}
        <div style={splitRow}>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Timeout (sec)</label>
                <input type="number" min={5} max={600} value={Number(cfg.timeout_sec || 20)}
                    onChange={e => updateCfg('timeout_sec', parseInt(e.target.value) || 20)}
                    style={fieldStyle} disabled={isProtected} />
            </div>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Caller ID</label>
                <select value={String(cfg.caller_id_policy || 'preserve_called_number')} onChange={e => updateCfg('caller_id_policy', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="preserve_called_number">Preserve called number</option>
                    <option value="default_outbound_number">Default outbound</option>
                    <option value="explicit_number">Explicit number</option>
                </select>
            </div>
        </div>
        {cfg.caller_id_policy === 'explicit_number' && (
            <div style={row}>
                <label style={labelStyle}>Explicit Caller ID <span style={{ color: '#ef4444' }}>*</span></label>
                <input value={String(cfg.explicit_caller_id_number || '')} onChange={e => updateCfg('explicit_caller_id_number', e.target.value)} style={fieldStyle} placeholder="+1…" />
            </div>
        )}
        <div style={row}>
            <label style={labelStyle}>On Fail</label>
            <select value={String(cfg.on_fail || 'edge')} onChange={e => updateCfg('on_fail', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="edge">Follow edge</option>
                <option value="voicemail_terminal">Go to voicemail</option>
                <option value="hangup_terminal">Hang up</option>
            </select>
        </div>
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOICEMAIL
// ═══════════════════════════════════════════════════════════════════════════════
export function VoicemailInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    return (<>
        <div style={row}>
            <label style={labelStyle}>Mailbox</label>
            <select value={String(cfg.mailbox_mode || 'current_group_default')} onChange={e => updateCfg('mailbox_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="current_group_default">Current group default</option>
                <option value="specific_mailbox">Specific mailbox</option>
            </select>
        </div>
        <div style={row}>
            <label style={labelStyle}>Greeting</label>
            <select value={String(cfg.greeting_mode || 'inherit_from_group')} onChange={e => updateCfg('greeting_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="inherit_from_group">Inherit from group</option>
                <option value="tts">TTS text</option>
                <option value="audio_asset">Audio asset</option>
            </select>
        </div>
        {cfg.greeting_mode === 'tts' && (<>
            <div style={row}>
                <label style={labelStyle}>Greeting Text <span style={{ color: '#ef4444' }}>*</span></label>
                <textarea value={String(cfg.greeting_text || '')} onChange={e => updateCfg('greeting_text', e.target.value)}
                    rows={2} style={{ ...fieldStyle, resize: 'vertical' }} placeholder="Leave a message after the beep…" />
            </div>
            <div style={splitRow}>
                <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Voice</label>
                    <select value={String(cfg.tts_voice_key || 'woman')} onChange={e => updateCfg('tts_voice_key', e.target.value)} style={fieldStyle}>
                        <option value="man">Man</option>
                        <option value="woman">Woman</option>
                        <option value="Polly.Joanna">Polly.Joanna</option>
                    </select>
                </div>
                <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Language</label>
                    <select value={String(cfg.tts_language_code || 'en-US')} onChange={e => updateCfg('tts_language_code', e.target.value)} style={fieldStyle}>
                        <option value="en-US">English (US)</option>
                        <option value="es-US">Spanish (US)</option>
                    </select>
                </div>
            </div>
        </>)}
        {cfg.greeting_mode === 'audio_asset' && (
            <div style={row}>
                <label style={labelStyle}>Audio Asset <span style={{ color: '#ef4444' }}>*</span></label>
                <input value={String(cfg.greeting_audio_asset_id || '')} onChange={e => updateCfg('greeting_audio_asset_id', e.target.value)} style={fieldStyle} placeholder="Asset ID (picker coming soon)" />
            </div>
        )}
        <div style={splitRow}>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Max Length (sec)</label>
                <input type="number" min={5} max={3600} value={Number(cfg.max_length_sec || 120)}
                    onChange={e => updateCfg('max_length_sec', parseInt(e.target.value) || 120)} style={fieldStyle} />
            </div>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Finish Key</label>
                <input value={String(cfg.finish_on_key || '#')} onChange={e => updateCfg('finish_on_key', e.target.value)} style={fieldStyle} maxLength={1} />
            </div>
        </div>
        <div style={{ marginTop: 4 }}>
            <label style={checkLabel}><input type="checkbox" checked={cfg.play_beep !== false} onChange={e => updateCfg('play_beep', e.target.checked)} style={{ accentColor: '#ef4444' }} />Play beep</label>
            <label style={checkLabel}><input type="checkbox" checked={cfg.trim_silence !== false} onChange={e => updateCfg('trim_silence', e.target.checked)} style={{ accentColor: '#ef4444' }} />Trim silence</label>
            <label style={checkLabel}><input type="checkbox" checked={cfg.transcription_enabled !== false} onChange={e => updateCfg('transcription_enabled', e.target.checked)} style={{ accentColor: '#ef4444' }} />Enable transcription</label>
        </div>
        <div style={{ marginTop: 8, padding: '6px 8px', background: '#fef2f2', borderRadius: 6, fontSize: 10, color: '#991b1b' }}>
            ⏹ Terminal node — flow ends here
        </div>
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANG UP
// ═══════════════════════════════════════════════════════════════════════════════
export function HangUpInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    return (<>
        <div style={row}>
            <label style={labelStyle}>Reason</label>
            <select value={String(cfg.reason_code || 'admin_defined')} onChange={e => updateCfg('reason_code', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="admin_defined">Admin defined</option>
                <option value="rejected_by_business_rule">Rejected by business rule</option>
                <option value="closed_no_voicemail">Closed (no voicemail)</option>
                <option value="queue_timeout_no_voicemail">Queue timeout (no voicemail)</option>
                <option value="transfer_failed_no_fallback">Transfer failed (no fallback)</option>
            </select>
        </div>
        <div style={row}>
            <label style={labelStyle}>Analytics Label</label>
            <input value={String(cfg.analytics_label || '')} onChange={e => updateCfg('analytics_label', e.target.value)} style={fieldStyle} placeholder="Optional label for analytics" />
        </div>
        <div style={row}>
            <label style={labelStyle}>Optional Message</label>
            <select value={String(cfg.optional_message_mode || 'none')} onChange={e => updateCfg('optional_message_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                <option value="none">None</option>
                <option value="tts">TTS text</option>
                <option value="audio_asset">Audio asset</option>
            </select>
        </div>
        {cfg.optional_message_mode === 'tts' && (
            <div style={row}>
                <label style={labelStyle}>Message Text <span style={{ color: '#ef4444' }}>*</span></label>
                <textarea value={String(cfg.optional_message_text || '')} onChange={e => updateCfg('optional_message_text', e.target.value)}
                    rows={2} style={{ ...fieldStyle, resize: 'vertical' }} placeholder="Goodbye message…" />
            </div>
        )}
        {cfg.optional_message_mode === 'audio_asset' && (
            <div style={row}>
                <label style={labelStyle}>Audio Asset <span style={{ color: '#ef4444' }}>*</span></label>
                <input value={String(cfg.optional_message_audio_asset_id || '')} onChange={e => updateCfg('optional_message_audio_asset_id', e.target.value)} style={fieldStyle} placeholder="Asset ID" />
            </div>
        )}
        <div style={{ marginTop: 8, padding: '6px 8px', background: '#f3f4f6', borderRadius: 6, fontSize: 10, color: '#6b7280' }}>
            ⏹ Terminal node — flow ends here
        </div>
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAY AUDIO
// ═══════════════════════════════════════════════════════════════════════════════
export function PlayAudioInspector({ cfg, updateCfg, isProtected }: InspectorProps) {
    return (<>
        <div style={row}>
            <label style={labelStyle}>Audio Asset <span style={{ color: '#ef4444' }}>*</span></label>
            <input value={String(cfg.audio_asset_id || '')} onChange={e => updateCfg('audio_asset_id', e.target.value)}
                style={fieldStyle} placeholder="Asset ID (picker coming soon)" disabled={isProtected} />
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>Select from Audio Library</div>
        </div>
        <div style={splitRow}>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>Repeat</label>
                <input type="number" min={1} max={10} value={Number(cfg.playback_count || 1)}
                    onChange={e => updateCfg('playback_count', parseInt(e.target.value) || 1)}
                    style={fieldStyle} disabled={isProtected} />
            </div>
            <div style={{ flex: 1 }}>
                <label style={labelStyle}>On Failure</label>
                <select value={String(cfg.fallback_mode || 'skip_node')} onChange={e => updateCfg('fallback_mode', e.target.value)} style={fieldStyle} disabled={isProtected}>
                    <option value="skip_node">Skip node</option>
                    <option value="edge">Follow edge</option>
                </select>
            </div>
        </div>
        <label style={checkLabel}><input type="checkbox" checked={cfg.stop_if_call_disconnected !== false} onChange={e => updateCfg('stop_if_call_disconnected', e.target.checked)} style={{ accentColor: '#ec4899' }} disabled={isProtected} />Stop if call disconnected</label>
    </>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPATCHER — maps kind to inspector component
// ═══════════════════════════════════════════════════════════════════════════════
export function NodeKindInspector({ kind, cfg, updateCfg, isProtected }: InspectorProps & { kind: CallFlowNodeKind }) {
    switch (kind) {
        case 'greeting': return <GreetingInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        case 'queue': return <QueueInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        case 'branch': return <BranchInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        case 'transfer': return <TransferInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        case 'voicemail': return <VoicemailInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        case 'hangup': return <HangUpInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        case 'play_audio': return <PlayAudioInspector cfg={cfg} updateCfg={updateCfg} isProtected={isProtected} />;
        default: return null;
    }
}

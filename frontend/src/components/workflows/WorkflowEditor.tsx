import { useState, useEffect, useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { toast } from 'sonner';
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Save,
  Upload,
  Download,
  History,
  ShieldCheck,
} from 'lucide-react';
import ProblemsPanel from './ProblemsPanel';
import {
  useFsmDraft,
  useFsmActiveVersion,
  useSaveDraft,
  useValidateScxml,
  usePublishDraft,
  type ValidationResult,
} from '../../hooks/useFsmEditor';
import { useAuthz } from '../../hooks/useAuthz';

/* ── Minimal SCXML template for new machines ─────────────────────────── */

const MINIMAL_SCXML = `<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" initial="new">
  <state id="new">
    <transition event="start" target="in_progress" />
  </state>
  <state id="in_progress">
    <transition event="complete" target="done" />
  </state>
  <final id="done" />
</scxml>
`;

/* ── Props ────────────────────────────────────────────────────────────── */

interface WorkflowEditorProps {
  machineKey: string;
  onBack: () => void;
}

/* ── Component ────────────────────────────────────────────────────────── */

export default function WorkflowEditor({ machineKey, onBack }: WorkflowEditorProps) {
  /* state */
  const [editorContent, setEditorContent] = useState('');
  const [lastSavedContent, setLastSavedContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [_debouncedContent, setDebouncedContent] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialised = useRef(false);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleProblemClick = useCallback((line: number, col: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: col });
    editor.focus();
  }, []);

  /* data hooks */
  const { data: draft, isLoading: draftLoading } = useFsmDraft(machineKey);
  const { data: active, isLoading: activeLoading } = useFsmActiveVersion(machineKey);
  const saveDraft = useSaveDraft(machineKey);
  const validateScxml = useValidateScxml(machineKey);
  const publishDraft = usePublishDraft(machineKey);
  const { hasPermission } = useAuthz();
  const canPublish = hasPermission('fsm.publisher');

  /* initialise editor content from draft -> active -> template */
  useEffect(() => {
    if (initialised.current) return;
    if (draftLoading || activeLoading) return;

    let source = MINIMAL_SCXML;
    if (draft?.scxml_source) {
      source = draft.scxml_source;
    } else if (active?.scxml_source) {
      source = active.scxml_source;
    }
    setEditorContent(source);
    setLastSavedContent(source);
    setDebouncedContent(source);
    initialised.current = true;
  }, [draft, active, draftLoading, activeLoading]);

  /* debounce content changes for preview */
  const handleEditorChange = useCallback((value: string | undefined) => {
    const v = value || '';
    setEditorContent(v);
    setDirty(v !== lastSavedContent);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedContent(v), 300);
  }, [lastSavedContent]);

  /* keyboard shortcut: Ctrl/Cmd + S */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorContent, dirty]);

  /* ── Actions ──────────────────────────────────────────────────────── */

  const handleValidate = async () => {
    try {
      const result = await validateScxml.mutateAsync({ scxml_source: editorContent });
      setValidationResult(result);
      if (result.valid) {
        toast.success('SCXML is valid');
      } else {
        toast.error(`Validation failed — ${result.errors.length} error(s)`);
      }
    } catch {
      toast.error('Network error during validation');
    }
  };

  const handleSave = async () => {
    if (!dirty || saveDraft.isPending) return;
    try {
      await saveDraft.mutateAsync({ scxml_source: editorContent });
      setLastSavedContent(editorContent);
      setDirty(false);
      toast.success('Draft saved');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save draft';
      toast.error(message);
    }
  };

  const handlePublish = async () => {
    const changeNote = window.prompt('Enter a change note for this publish:');
    if (!changeNote) return;
    try {
      await publishDraft.mutateAsync({ change_note: changeNote });
      setLastSavedContent(editorContent);
      setDirty(false);
      setValidationResult(null);
      toast.success('Workflow published');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to publish';
      toast.error(message);
    }
  };

  const handleExport = () => {
    const blob = new Blob([editorContent], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${machineKey}-workflow.scxml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleHistory = () => {
    toast.info('Version history — coming soon');
  };

  /* ── Status pill ──────────────────────────────────────────────────── */

  const statusPill = (() => {
    if (validationResult && !validationResult.valid) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
          <XCircle className="w-3 h-3" /> Has errors
        </span>
      );
    }
    if (dirty) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
          <AlertTriangle className="w-3 h-3" /> Draft has changes
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="w-3 h-3" /> Valid
      </span>
    );
  })();

  /* ── Loading state ────────────────────────────────────────────────── */

  if (draftLoading || activeLoading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--blanc-ink-3)]">
        Loading workflow...
      </div>
    );
  }

  /* ── Render ───────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col h-full bg-[var(--blanc-bg)]">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="h-14 border-b border-[var(--blanc-line)] flex items-center px-4 gap-3 shrink-0">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)] transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="font-[var(--blanc-font-heading)] font-semibold">{machineKey}</span>
        </button>

        <div className="mx-2 h-5 w-px bg-[var(--blanc-line)]" />

        {statusPill}

        <div className="flex-1" />

        <button
          onClick={handleValidate}
          disabled={validateScxml.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
            bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors
            disabled:opacity-50"
        >
          <ShieldCheck className="w-3.5 h-3.5" /> Validate
        </button>

        <button
          onClick={handleSave}
          disabled={!dirty || saveDraft.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
            bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors
            disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" /> {saveDraft.isPending ? 'Saving...' : 'Save Draft'}
        </button>

        {canPublish && (
          <button
            onClick={handlePublish}
            disabled={publishDraft.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
              bg-emerald-600 text-white hover:bg-emerald-700 transition-colors
              disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" /> Publish
          </button>
        )}

        <button
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
            bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors"
        >
          <Download className="w-3.5 h-3.5" /> Export
        </button>

        <button
          onClick={handleHistory}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
            bg-[rgba(117,106,89,0.06)] text-[var(--blanc-ink-2)] hover:bg-[rgba(117,106,89,0.12)] transition-colors"
        >
          <History className="w-3.5 h-3.5" /> History
        </button>
      </div>

      {/* ── Split panes ──────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left pane: Monaco */}
        <div className="flex-1 min-w-0">
          <Editor
            height="100%"
            language="xml"
            value={editorContent}
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: true },
              lineNumbers: 'on',
              wordWrap: 'on',
              fontSize: 13,
              scrollBeyondLastLine: false,
            }}
          />
        </div>

        {/* Right pane: Diagram preview placeholder */}
        <div className="w-[45%] border-l border-[var(--blanc-line)] p-4 overflow-auto">
          <p className="blanc-eyebrow mb-3">Diagram Preview</p>
          <div className="flex items-center justify-center h-48 rounded-2xl bg-[rgba(117,106,89,0.04)] text-[var(--blanc-ink-3)] text-sm">
            Diagram will render here
          </div>

          {/* Problems panel */}
          {validationResult && !validationResult.valid && (
            <div className="mt-4">
              <ProblemsPanel
                errors={validationResult.errors}
                warnings={validationResult.warnings}
                onProblemClick={handleProblemClick}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

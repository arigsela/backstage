/**
 * KagentSuggest scaffolder field — calls a kagent agent during wizard form-fill
 * and lets the user accept suggestions item-by-item into a target form array.
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 *
 * IMPORTANT: this field never sets its own form value. It mutates a different
 * form field (specified by ui:options.targetField) via formContext.onChange.
 * The field's own value (the dummy string property in the template schema)
 * stays empty.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';

export interface KagentSuggestOptions {
  agent: string;
  targetField: string;
  promptTemplate: string;
  watchFields?: string[];
  itemShape: Record<string, 'text' | 'multiline'>;
  buttonLabel?: string;
  maxSuggestions?: number;
  timeoutMs?: number;
}

export interface KagentSuggestFieldProps {
  formData: string;
  onChange: (value: string) => void;
  uiSchema: { 'ui:options': KagentSuggestOptions };
  formContext: {
    formData: Record<string, unknown>;
    onChange: (data: Record<string, unknown>) => void;
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  AGENT_NOT_FOUND:
    'Agent is not in the catalog yet. Ask an operator to scaffold it before trying again.',
  INVALID_CONTRACT:
    'Agent is missing the v1 annotation contract. Re-scaffold it through the IDP wizard.',
  ENDPOINT_UNREACHABLE:
    "Couldn't reach the agent service. Is the kagent namespace up?",
  INVOCATION_TIMEOUT:
    "The agent didn't respond in time. Try simplifying the prompt or retrying.",
  AGENT_ERROR:
    "The agent returned an error. Check the agent's pod logs.",
  INVALID_RESPONSE_JSON:
    "The agent didn't return valid JSON. Either ask the operator to tune the agent's system message, or contact platform-eng.",
  BAD_INPUT:
    'Internal: the suggest field sent an invalid request. Reload the wizard.',
};

const useStyles = makeStyles(theme => ({
  root: { marginBottom: theme.spacing(2) },
  button: { marginRight: theme.spacing(1) },
  loading: { marginLeft: theme.spacing(1), verticalAlign: 'middle' },
  alert: { marginTop: theme.spacing(1), padding: theme.spacing(1.5) },
  preview: { marginTop: theme.spacing(2) },
  previewItem: {
    padding: theme.spacing(1.5),
    marginBottom: theme.spacing(1),
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
  },
  previewFields: { flex: 1 },
  added: { color: theme.palette.success.main, marginLeft: theme.spacing(1) },
}));

function renderPrompt(
  template: string,
  values: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const v = values[key];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

interface SuggestionEntry {
  data: Record<string, string>;
  added: boolean;
  addedAt?: number;
}

export function KagentSuggestField(props: KagentSuggestFieldProps) {
  const classes = useStyles();
  const opts = (props.uiSchema?.['ui:options'] ?? {}) as KagentSuggestOptions;
  const formData = props.formContext?.formData ?? {};
  const targetArray = (formData[opts.targetField] as any[]) ?? [];

  // TEMP DIAGNOSTIC — remove after Layer 2 validation passes.
  // eslint-disable-next-line no-console
  console.log('[KagentSuggest] uiSchema=', JSON.stringify(props.uiSchema), 'opts=', JSON.stringify(opts), 'formContext.formData keys=', Object.keys(formData));

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionEntry[]>([]);
  const [lastSentBody, setLastSentBody] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup any in-flight fetch on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const buttonDisabled = (() => {
    if (loading) return true;
    const watch = opts.watchFields ?? [];
    return watch.some(f => {
      const v = formData[f];
      return v == null || (typeof v === 'string' && v.trim() === '');
    });
  })();

  const handleSuggest = useCallback(async () => {
    setError(null);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const prompt = renderPrompt(opts.promptTemplate, formData);

    // TEMP DIAGNOSTIC — capture what we actually send.
    const requestBody = JSON.stringify({
      agentName: opts.agent,
      prompt,
      expectJson: true,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
    setLastSentBody(requestBody);
    // eslint-disable-next-line no-console
    console.log('[KagentSuggest] POST body:', requestBody);

    try {
      const res = await fetch('/api/kagent-suggest/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });

      const body = await res.json();
      if (!body.ok) {
        setError({ code: body.code, message: body.message });
        setSuggestions([]);
        return;
      }

      const raw = body.response;
      const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
      const max = opts.maxSuggestions ?? 10;
      const expectedKeys = Object.keys(opts.itemShape);

      const filtered = arr
        .filter(item =>
          item && typeof item === 'object' && expectedKeys.every(k => k in item),
        )
        .slice(0, max)
        .map(item => {
          const entry: Record<string, string> = {};
          for (const k of expectedKeys) entry[k] = String(item[k] ?? '');
          return { data: entry, added: false } as SuggestionEntry;
        });

      setSuggestions(filtered);
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // unmounted
      setError({ code: 'BAD_INPUT', message: e.message ?? String(e) });
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [opts, formData]);

  const handleEditSuggestion = (idx: number, key: string, value: string) => {
    setSuggestions(prev => {
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        data: { ...next[idx].data, [key]: value },
      };
      return next;
    });
  };

  const handleAdd = (idx: number) => {
    const entry = suggestions[idx];
    const newArr = [...targetArray, entry.data];
    props.formContext.onChange({
      ...formData,
      [opts.targetField]: newArr,
    });

    // Mark as added for 2 seconds.
    setSuggestions(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], added: true, addedAt: Date.now() };
      return next;
    });
    setTimeout(() => {
      setSuggestions(prev => {
        const next = [...prev];
        if (next[idx]) next[idx] = { ...next[idx], added: false };
        return next;
      });
    }, 2000);
  };

  return (
    <div className={classes.root}>
      <Button
        variant="outlined"
        color="primary"
        disabled={buttonDisabled}
        onClick={handleSuggest}
        className={classes.button}
      >
        {opts.buttonLabel ?? 'Suggest'}
      </Button>
      {loading && (
        <CircularProgress
          size={20}
          className={classes.loading}
          role="progressbar"
        />
      )}

      {error && (
        <Paper className={classes.alert} elevation={0} role="alert">
          <Typography color="error">
            {ERROR_MESSAGES[error.code] ?? `${error.code}: ${error.message}`}
          </Typography>
          {/* TEMP DIAGNOSTIC — remove after Layer 2 validation passes. */}
          <Typography variant="caption" component="pre" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
            Diagnostic — opts: {JSON.stringify(opts)}{'\n'}
            uiSchema keys: {Object.keys(props.uiSchema ?? {}).join(', ')}{'\n'}
            Sent body: {lastSentBody ?? '(none captured)'}
          </Typography>
        </Paper>
      )}

      {suggestions.length > 0 && (
        <div className={classes.preview}>
          <Typography variant="subtitle2">Suggestions:</Typography>
          {suggestions.map((entry, idx) => (
            <Paper key={idx} className={classes.previewItem} variant="outlined">
              <div className={classes.previewFields}>
                {Object.entries(opts.itemShape).map(([key, kind]) => (
                  <TextField
                    key={key}
                    label={key}
                    value={entry.data[key]}
                    onChange={e => handleEditSuggestion(idx, key, e.target.value)}
                    fullWidth
                    multiline={kind === 'multiline'}
                    margin="dense"
                  />
                ))}
              </div>
              <Button
                variant="contained"
                color="primary"
                size="small"
                onClick={() => handleAdd(idx)}
              >
                Add
              </Button>
              {entry.added && (
                <Typography variant="caption" className={classes.added}>
                  ✓ Added
                </Typography>
              )}
            </Paper>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * KagentSuggest scaffolder field — calls a kagent agent during wizard form-fill
 * and lets the user accept suggestions item-by-item.
 *
 * The field IS the array (e.g. the Skills array). Its formData is the
 * SkillItem[] and props.onChange(newArray) updates form state. Drop-in
 * replacement for the rjsf default array editor on any list-shaped property.
 *
 * UX:
 *   - Empty state: button + "0 items added" summary
 *   - Click Suggest: agent returns N suggestions, rendered as editable preview rows
 *   - Click Add on a row: item appended to form state, row vanishes from preview
 *   - Re-clicking Suggest with items already added: prompt auto-appended with
 *     "do NOT duplicate these existing items: [ids]" so the agent gives fresh ideas
 *
 * Companion spec: docs/superpowers/specs/2026-05-21-kagent-suggest-field-design.md
 * (see Amendment section)
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
  promptTemplate: string;
  watchFields?: string[];
  itemShape: Record<string, 'text' | 'multiline'>;
  buttonLabel?: string;
  maxSuggestions?: number;
  timeoutMs?: number;
}

export interface KagentSuggestFieldProps {
  formData?: Array<Record<string, string>>;
  onChange: (value: Array<Record<string, string>>) => void;
  uiSchema: { 'ui:options': KagentSuggestOptions };
  formContext: {
    formData: Record<string, unknown>;
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
  summary: {
    marginTop: theme.spacing(1),
    color: theme.palette.text.secondary,
  },
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

function buildPromptWithAntiDup(
  template: string,
  values: Record<string, unknown>,
  existingIds: string[],
): string {
  const base = renderPrompt(template, values);
  if (existingIds.length === 0) {
    return base;
  }
  return `${base}\n\nThe user has already added these items (do NOT duplicate them):\n[${existingIds.join(', ')}]`;
}

export function KagentSuggestField(props: KagentSuggestFieldProps) {
  const classes = useStyles();
  const opts = (props.uiSchema?.['ui:options'] ?? {}) as KagentSuggestOptions;
  const formContextData = props.formContext?.formData ?? {};
  const currentItems = Array.isArray(props.formData) ? props.formData : [];

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [suggestions, setSuggestions] = useState<Array<Record<string, string>>>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const buttonDisabled = (() => {
    if (loading) return true;
    const watch = opts.watchFields ?? [];
    return watch.some(f => {
      const v = formContextData[f];
      return v == null || (typeof v === 'string' && v.trim() === '');
    });
  })();

  const handleSuggest = useCallback(async () => {
    setError(null);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const existingIds = currentItems
      .map(item => String(item.id ?? ''))
      .filter(id => id.length > 0);
    const prompt = buildPromptWithAntiDup(
      opts.promptTemplate,
      formContextData,
      existingIds,
    );

    try {
      const res = await fetch('/api/kagent-suggest/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: opts.agent,
          prompt,
          expectJson: true,
          timeoutMs: opts.timeoutMs ?? 60_000,
        }),
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
          return entry;
        });

      setSuggestions(filtered);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setError({ code: 'BAD_INPUT', message: e.message ?? String(e) });
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [opts, formContextData, currentItems]);

  const handleEditSuggestion = (idx: number, key: string, value: string) => {
    setSuggestions(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [key]: value };
      return next;
    });
  };

  const handleAdd = (idx: number) => {
    const entry = suggestions[idx];
    props.onChange([...currentItems, entry]);
    // Remove the added row from preview immediately.
    setSuggestions(prev => prev.filter((_, i) => i !== idx));
  };

  const count = currentItems.length;
  const summary =
    count === 0 ? '0 items added' : `${count} item${count === 1 ? '' : 's'} added`;

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

      <Typography variant="body2" className={classes.summary}>
        {summary}
      </Typography>

      {error && (
        <Paper className={classes.alert} elevation={0} role="alert">
          <Typography color="error">
            {ERROR_MESSAGES[error.code] ?? `${error.code}: ${error.message}`}
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
                    value={entry[key]}
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
            </Paper>
          ))}
        </div>
      )}
    </div>
  );
}

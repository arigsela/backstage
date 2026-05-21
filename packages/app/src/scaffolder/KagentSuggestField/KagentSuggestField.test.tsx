/**
 * Unit tests for the KagentSuggest field component.
 *
 * Uses @testing-library/react + jest.spyOn(global, 'fetch') to mock the
 * backend route. The field reads props via rjsf's FieldExtensionComponentProps,
 * which we synthesize manually in each test.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KagentSuggestField } from './KagentSuggestField';

function buildProps(overrides: any = {}) {
  return {
    formData: '',
    onChange: jest.fn(),
    uiSchema: {
      'ui:options': {
        agent: 'skill-suggester',
        targetField: 'skills',
        promptTemplate: 'Suggest skills for: "{{ description }}"',
        watchFields: ['description'],
        itemShape: { id: 'text', name: 'text', description: 'text' },
        buttonLabel: 'Suggest skills',
        ...overrides.uiOptions,
      },
    },
    formContext: {
      formData: overrides.formData ?? { description: '', skills: [] },
      onChange: jest.fn(),
    },
    ...overrides.extra,
  } as any;
}

function mockOkResponse(items: any[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      agentName: 'skill-suggester',
      runtime: 'kagent',
      durationMs: 1234,
      response: items,
    }),
  } as any;
}

function mockFailResponse(code: string, message: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: false, code, message }),
  } as any;
}

describe('KagentSuggestField', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('renders with disabled button when watched field is empty', () => {
    render(<KagentSuggestField {...buildProps({ formData: { description: '' } })} />);
    const btn = screen.getByRole('button', { name: /suggest skills/i });
    expect(btn).toBeDisabled();
  });

  it('enables button when watched field is non-empty', () => {
    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    const btn = screen.getByRole('button', { name: /suggest skills/i });
    expect(btn).toBeEnabled();
  });

  it('click fires fetch to /api/kagent-suggest/invoke with the right body', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('/api/kagent-suggest/invoke');
    const body = JSON.parse(call[1].body);
    expect(body.agentName).toBe('skill-suggester');
    expect(body.expectJson).toBe(true);
    expect(body.prompt).toContain('Suggest skills for: "My agent"');
  });

  it('mustache interpolation — {{ description }} pulls from formContext.formData.description', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'unique-test-value-xyz' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt).toContain('unique-test-value-xyz');
    expect(body.prompt).not.toContain('{{ description }}');
  });

  it('loading state — button disabled and shows spinner during fetch', async () => {
    let resolveFetch: any;
    fetchSpy.mockImplementationOnce(
      () => new Promise(r => { resolveFetch = r; }),
    );

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /suggest skills/i })).toBeDisabled();

    // Resolve so the test cleans up.
    resolveFetch(mockOkResponse([]));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  });

  it('happy path — suggestions render as preview rows with editable inputs', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
      { id: 'classify', name: 'Classify', description: 'Labels input.' },
    ]));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Parse Text')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Extracts entities.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('classify')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^add$/i })).toHaveLength(2);
  });

  it('Add button — calls formContext.onChange with the merged target array', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({
      formData: { description: 'My agent', skills: [{ id: 'existing', name: 'Existing', description: 'x' }] },
    });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(props.formContext.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          { id: 'existing', name: 'Existing', description: 'x' },
          { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
        ],
      }),
    );
  });

  it('Add twice — both calls append to the array (no dedupe)', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({ formData: { description: 'My agent', skills: [] } });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    const addBtn = screen.getByRole('button', { name: /^add$/i });
    await userEvent.click(addBtn);
    await userEvent.click(addBtn);

    expect(props.formContext.onChange).toHaveBeenCalledTimes(2);
  });

  it('AGENT_NOT_FOUND — shows user-facing error, no suggestions render, button re-enables', async () => {
    fetchSpy.mockResolvedValueOnce(mockFailResponse('AGENT_NOT_FOUND', 'no entity'));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/not in the catalog yet/i);
    expect(screen.queryByDisplayValue(/parse-text/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /suggest skills/i })).toBeEnabled();
  });

  it('INVALID_RESPONSE_JSON — shows operator-action-required message', async () => {
    fetchSpy.mockResolvedValueOnce(mockFailResponse('INVALID_RESPONSE_JSON', 'bad json'));

    render(<KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/didn't return valid JSON/i);
  });

  it('edit-then-Add — modifying preview row text before Add appends edited values', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({ formData: { description: 'My agent', skills: [] } });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    const idInput = screen.getByDisplayValue('parse-text');
    fireEvent.change(idInput, { target: { value: 'edited-id' } });

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(props.formContext.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          expect.objectContaining({ id: 'edited-id' }),
        ],
      }),
    );
  });

  it('unmount during loading — AbortController is called', async () => {
    let abortCalled = false;
    fetchSpy.mockImplementationOnce((_url: string, init: any) => {
      init.signal?.addEventListener('abort', () => { abortCalled = true; });
      return new Promise(() => {});
    });

    const { unmount } = render(
      <KagentSuggestField {...buildProps({ formData: { description: 'My agent' } })} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    unmount();

    await waitFor(() => expect(abortCalled).toBe(true));
  });
});

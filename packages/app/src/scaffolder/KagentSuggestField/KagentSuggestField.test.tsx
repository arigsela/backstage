/**
 * Unit tests for the KagentSuggest field component.
 *
 * The field owns its own value (array of items) and updates via props.onChange.
 * formContext.formData is read-only (used for interpolating prompt placeholders
 * like {{ description }}).
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KagentSuggestField } from './KagentSuggestField';

function buildProps(overrides: any = {}) {
  return {
    formData: overrides.formData ?? [],
    onChange: jest.fn(),
    uiSchema: {
      'ui:options': {
        agent: 'skill-suggester',
        promptTemplate: 'Suggest skills for: "{{ description }}"',
        watchFields: ['description'],
        itemShape: { id: 'text', name: 'text', description: 'text' },
        buttonLabel: 'Suggest skills',
        ...overrides.uiOptions,
      },
    },
    formContext: {
      formData: overrides.contextFormData ?? { description: '' },
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

  it('empty state shows "0 items added" summary', () => {
    render(<KagentSuggestField {...buildProps()} />);
    expect(screen.getByText('0 items added')).toBeInTheDocument();
  });

  it('non-empty state shows N items added summary', () => {
    const props = buildProps({
      formData: [
        { id: 'a', name: 'A', description: 'x' },
        { id: 'b', name: 'B', description: 'y' },
      ],
    });
    render(<KagentSuggestField {...props} />);
    expect(screen.getByText('2 items added')).toBeInTheDocument();
  });

  it('summary uses singular for exactly 1 item', () => {
    const props = buildProps({
      formData: [{ id: 'a', name: 'A', description: 'x' }],
    });
    render(<KagentSuggestField {...props} />);
    expect(screen.getByText('1 item added')).toBeInTheDocument();
  });

  it('renders with disabled button when watched field is empty', () => {
    render(<KagentSuggestField {...buildProps()} />);
    const btn = screen.getByRole('button', { name: /suggest skills/i });
    expect(btn).toBeDisabled();
  });

  it('enables button when watched field is non-empty', () => {
    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    const btn = screen.getByRole('button', { name: /suggest skills/i });
    expect(btn).toBeEnabled();
  });

  it('click fires fetch to /api/kagent-suggest/invoke with the right body', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('/api/kagent-suggest/invoke');
    const body = JSON.parse(call[1].body);
    expect(body.agentName).toBe('skill-suggester');
    expect(body.expectJson).toBe(true);
    expect(body.prompt).toContain('Suggest skills for: "My agent"');
  });

  it('mustache interpolation pulls {{ description }} from formContext.formData', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'unique-test-value-xyz' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt).toContain('unique-test-value-xyz');
    expect(body.prompt).not.toContain('{{ description }}');
  });

  it('anti-dup suffix is appended when formData has existing items', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    const props = buildProps({
      contextFormData: { description: 'My agent' },
      formData: [
        { id: 'parse-text', name: 'Parse Text', description: 'x' },
        { id: 'classify', name: 'Classify', description: 'y' },
      ],
    });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt).toContain('do NOT duplicate');
    expect(body.prompt).toContain('parse-text');
    expect(body.prompt).toContain('classify');
  });

  it('anti-dup suffix is NOT appended when formData is empty', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([]));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.prompt).not.toContain('do NOT duplicate');
  });

  it('loading state — button disabled and shows spinner during fetch', async () => {
    let resolveFetch: any;
    fetchSpy.mockImplementationOnce(
      () => new Promise(r => { resolveFetch = r; }),
    );

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /suggest skills/i })).toBeDisabled();

    resolveFetch(mockOkResponse([]));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  });

  it('happy path — suggestions render as preview rows with editable inputs', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
      { id: 'classify', name: 'Classify', description: 'Labels input.' },
    ]));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Parse Text')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Extracts entities.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('classify')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^add$/i })).toHaveLength(2);
  });

  it('Add button calls props.onChange with the appended array', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({
      contextFormData: { description: 'My agent' },
      formData: [{ id: 'existing', name: 'Existing', description: 'x' }],
    });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(props.onChange).toHaveBeenCalledWith([
      { id: 'existing', name: 'Existing', description: 'x' },
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]);
  });

  it('Add removes the added row from the preview', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
      { id: 'classify', name: 'Classify', description: 'Labels input.' },
    ]));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    // Two rows visible.
    expect(screen.getAllByRole('button', { name: /^add$/i })).toHaveLength(2);

    // Click the first Add — parse-text should vanish.
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]);

    await waitFor(() => expect(screen.queryByDisplayValue('parse-text')).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('classify')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^add$/i })).toHaveLength(1);
  });

  it('edit-then-Add commits the edited suggestion', async () => {
    fetchSpy.mockResolvedValueOnce(mockOkResponse([
      { id: 'parse-text', name: 'Parse Text', description: 'Extracts entities.' },
    ]));

    const props = buildProps({ contextFormData: { description: 'My agent' } });
    render(<KagentSuggestField {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(screen.getByDisplayValue('parse-text')).toBeInTheDocument());

    const idInput = screen.getByDisplayValue('parse-text');
    fireEvent.change(idInput, { target: { value: 'edited-id' } });

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(props.onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'edited-id' }),
    ]);
  });

  it('AGENT_NOT_FOUND shows user-facing error and button re-enables', async () => {
    fetchSpy.mockResolvedValueOnce(mockFailResponse('AGENT_NOT_FOUND', 'no entity'));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/not in the catalog yet/i);
    expect(screen.queryByDisplayValue(/parse-text/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /suggest skills/i })).toBeEnabled();
  });

  it('INVALID_RESPONSE_JSON shows operator-action-required message', async () => {
    fetchSpy.mockResolvedValueOnce(mockFailResponse('INVALID_RESPONSE_JSON', 'bad json'));

    render(<KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />);
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/didn't return valid JSON/i);
  });

  it('unmount during loading — AbortController is called', async () => {
    let abortCalled = false;
    fetchSpy.mockImplementationOnce((_url: string, init: any) => {
      init.signal?.addEventListener('abort', () => { abortCalled = true; });
      return new Promise(() => {});
    });

    const { unmount } = render(
      <KagentSuggestField {...buildProps({ contextFormData: { description: 'My agent' } })} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /suggest skills/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    unmount();

    await waitFor(() => expect(abortCalled).toBe(true));
  });
});

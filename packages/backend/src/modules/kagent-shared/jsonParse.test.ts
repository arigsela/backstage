import { tolerantParseJson } from './jsonParse';

describe('tolerantParseJson', () => {
  it('parses plain JSON', () => {
    expect(tolerantParseJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('parses JSON wrapped in ```json fence', () => {
    const text = '```json\n[{"id":"a","name":"A","description":"x"}]\n```';
    expect(tolerantParseJson(text)).toEqual([
      { id: 'a', name: 'A', description: 'x' },
    ]);
  });

  it('parses JSON wrapped in plain ``` fence', () => {
    const text = '```\n[{"a":1}]\n```';
    expect(tolerantParseJson(text)).toEqual([{ a: 1 }]);
  });

  it('extracts a JSON array from text with prose preamble', () => {
    const text = 'Here are 3 suggestions:\n[{"id":"a","name":"A","description":"x"}]';
    expect(tolerantParseJson(text)).toEqual([
      { id: 'a', name: 'A', description: 'x' },
    ]);
  });

  it('extracts a JSON array from text with prose postamble', () => {
    const text = '[{"a":1}]\n\nLet me know if you want more.';
    expect(tolerantParseJson(text)).toEqual([{ a: 1 }]);
  });

  it('extracts a JSON object when no array is present', () => {
    const text = 'Sure! {"foo":"bar"}';
    expect(tolerantParseJson(text)).toEqual({ foo: 'bar' });
  });

  it('throws with a useful message when no JSON is found', () => {
    expect(() => tolerantParseJson('totally not json, sorry')).toThrow(
      /Could not extract JSON/,
    );
  });
});

/**
 * Tolerant JSON parser for LLM agent responses. Real-world agents frequently
 * wrap their JSON in markdown code fences, add prose preambles, or include
 * trailing notes — even when the prompt says "respond with ONLY JSON". This
 * parser handles the common patterns before giving up.
 *
 * Strategy (each step is a fallback; first success wins):
 *   1. Direct JSON.parse on the trimmed input.
 *   2. Strip surrounding markdown code fence (```json ... ``` or ``` ... ```).
 *   3. Extract first balanced [...] within the text.
 *   4. Extract first balanced {...} within the text.
 *
 * Returns the parsed value. Throws a descriptive Error on total failure.
 */
export function tolerantParseJson(text: string): unknown {
  const cleaned = text.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    /* try next strategy */
  }

  // Strip ```json ... ``` or ``` ... ``` (markdown code fence).
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* try next strategy */
    }
  }

  // Greedy: look for the outermost [...] block.
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      /* try next strategy */
    }
  }

  // Greedy: look for the outermost {...} block.
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      /* fall through to throw */
    }
  }

  throw new Error(
    `Could not extract JSON from response (first 200 chars: ${cleaned.slice(0, 200)})`,
  );
}

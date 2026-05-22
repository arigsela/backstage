# Scaffolder Field: `KagentSuggest` — Design Spec

> **Goal:** Give Backstage scaffolder wizards a reusable React field that
> interactively calls a kagent.dev Agent during form-fill, so users can
> get AI-generated suggestions (skills, descriptions, system messages,
> anything) and accept them into the form before submitting.
>
> **Status:** Approved design — implementation plan to follow. **Amended
> 2026-05-21** after Layer 2 validation revealed that
> `formContext.onChange` is not available — see Amendment section
> directly below.
> **Date:** 2026-05-21.
> **Author:** Ari Sela (with Claude).
> **Companion spec:** `docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md`.
> **Companion guide:** `docs/guides/scaffolder-action-kagent-invoke.md`.

---

## Amendment (2026-05-21): field owns the value

Layer 2 validation revealed that Backstage's `formContext` does NOT
expose a form-mutation `onChange` method — only metadata. The original
design's "separate `skillSuggest` field that writes to `skills` via
`formContext.onChange`" pattern is impossible. **Refactor the field to
BE the skills array directly, owning its own value via rjsf's standard
`props.onChange`.**

This amendment supersedes Sections 3, 5, 6, 7, and 8 of the original
design where they conflict. Other sections (1, 2, 4, 9, 10) remain
valid.

### Architecture (replaces §3 unit layout)

The field's `formData` is `SkillItem[]`. `props.onChange(newArray)`
updates form state. Drop `targetField` from `ui:options` entirely.
Template uses a single property (e.g. `skills`) with
`ui:field: KagentSuggest` — replaces the previous `skillSuggest` +
`skills` two-property pattern.

### UX flow

```
Initial state:
┌─ AI assist ─────────────────────────────┐
│  [ Suggest skills ]                     │
│  0 skills added                         │
└─────────────────────────────────────────┘

After clicking Suggest:
┌─ AI assist ─────────────────────────────┐
│  [ Suggest skills ]                     │
│  0 skills added                         │
│                                         │
│  Suggestions:                           │
│  ┌───────────────────┐ ┌─────┐           │
│  │ id: ...           │ │ Add │           │
│  │ name: ...         │ └─────┘           │
│  │ description: ...  │                   │
│  └───────────────────┘                   │
│  ┌───────────────────┐ ┌─────┐           │
│  │ id: ...           │ │ Add │           │
│  └───────────────────┘                   │
└─────────────────────────────────────────┘

After clicking Add on the first row:
  - That row disappears from the preview
  - Summary updates: "1 skill added"
  - Form state's skills array grows by one
```

**No inline editing of added items.** Suggestions can be edited in
their textboxes BEFORE Add. After Add, items are committed to form
state and only visible via the count summary. Recovery from accidental
adds is via the Review-page editor.

### `ui:options` contract (replaces §5 contract table)

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | string | yes | Catalog name of the agent to call. |
| ~~`targetField`~~ | — | — | **REMOVED.** Field writes to its own value. |
| `promptTemplate` | string | yes | Mustache `{{ field }}` placeholders interpolated from `formContext.formData`. |
| `watchFields` | string[] | no | Disable button until all listed fields are non-empty. |
| `itemShape` | object | yes | `{key: 'text' \| 'multiline'}` — drives preview-row rendering. |
| `buttonLabel` | string | no | Default `"Suggest"`. |
| `maxSuggestions` | integer | no | Default 10. |
| `timeoutMs` | integer | no | Default 60000. |

### Anti-duplicate prompt logic (new behavior)

When `formData.length > 0`, the field auto-appends to the rendered
prompt:

```
\n\nThe user has already added these items (do NOT duplicate them):
[<comma-separated list of ids>]
```

Hard-coded — no template-author opt-in needed. Phrasing is neutral
enough for any list-shaped use case. The list uses the `id` key from
each item (which the spec already requires as the first property of
`itemShape` for the skills use case).

### Add behavior (replaces §6 "After Add" subsection)

1. Append item (with any edits made in the preview textboxes) to the field's value via `props.onChange([...formData, item])`.
2. Remove that item from the preview state immediately.
3. No "✓ Added" badge (the row is gone; the count summary moved up by one).
4. Suggestions stay if other rows remain. User can click Suggest again — fresh request with the new existing-items context.

### Template change (replaces §5 template usage example)

```yaml
properties:
  skills:
    type: array
    title: A2A skills
    default: []
    ui:field: KagentSuggest
    ui:options:
      agent: skill-suggester
      promptTemplate: |
        Suggest 3 A2A skills for a kagent agent described as:
        "{{ description }}"
        Respond with ONLY a JSON array of exactly 3 objects, each with:
          - id: kebab-case identifier
          - name: Title Case display name
          - description: one-sentence summary
        No prose. No markdown. Just the JSON array.
      watchFields: [description]
      itemShape:
        id: text
        name: text
        description: text
      buttonLabel: Suggest skills
      maxSuggestions: 3
      timeoutMs: 60000
```

Note: `items: { ... }` schema is no longer needed. The field renders
and validates items itself. Type stays `array` so the submit shape
matches the downstream `${{ parameters.skills }}` interpolation.

### Test updates (replaces §7 Layer 2 frontend test list)

Still 12 tests total — most are minor edits:

- Drop `formContext.onChange` mock usage everywhere → use `props.onChange`.
- Tests #7 (Add button) and #8 (Add twice) assert on `props.onChange`.
- Drop test #11 (edit-then-Add of already-added items) — no inline editing in new design. Replace with: edit-suggestion-before-Add commits edited values.
- **New** test: anti-dup suffix appended when `formData` is non-empty.
- **New** test: clicked row vanishes from preview after Add.
- **New** test: empty state shows "0 skills added" / non-empty state shows "N skill(s) added".

### Out of scope (unchanged)

Streaming, multi-turn, modal preview, caching, auto-debounce, in-field
editing/deleting of added items, per-user permissions, telemetry.

---

## 1. Background

The branch `feat/kagent-v1.8-k8s-tab` shipped `kagent:agent:invoke`, a
synchronous backend scaffolder action that invokes a kagent agent via
the A2A protocol after the wizard is submitted. That primitive works
for post-submit invocations ("write the agent's response into the PR
body before opening it"). Layer 2 validation succeeded against
`dnd-agent`: 5.4s round-trip, response read at
`.result.artifacts[0].parts[0].text`, contract validated end-to-end.

What the action *can't* do is give the user agent suggestions while
they're still filling out the form. The user wanted that — "let me
type a description, click a button, and have the agent suggest skills
before I submit." This spec builds the missing piece: a custom
scaffolder frontend field plus the backend endpoint that powers it.

The motivating use case is the kagent-agent template's A2A Skills page,
where a user currently has to think up skill metadata from scratch. A
`skill-suggester` kagent agent (scaffolded once by an operator through
the existing wizard) can propose three structured suggestions which
the user can edit and accept item by item.

## 2. Approach

Three units, each independently testable. A **shared library**
extracted from the existing scaffolder action holds the resolver + A2A
invoker — the action and the new HTTP route both consume it as a
library. The action's wire format and contract validation remain the
single source of truth.

A **new backend module** (`kagent-suggest`) exposes one HTTP route at
`POST /api/kagent-suggest/invoke`. The route is a thin wrapper over the
shared library that returns `{ok, response, …}` JSON. It uses the
standard backend auth middleware (session cookie) and lives behind the
same in-cluster network posture as the action.

A **new frontend field** (`KagentSuggest`) is a React component
registered via `createScaffolderFieldExtension`. It's configured per
use via `ui:options` (target agent, prompt template with Mustache-style
placeholders, target field to append suggestions into, item shape).
It renders a Suggest button, a preview list with inline-editable
suggestions, and per-row Add buttons that append to the form's target
array via `formContext.onChange`.

Rollout is gated by the user-driven scaffold of the `skill-suggester`
agent (one-time setup using the existing kagent-agent template). The
field is dead code until at least one template wires it in.

## 3. Architecture

```
                        ┌──────────────────────────────┐
                        │ Backstage Frontend (browser) │
                        │                              │
                        │  Scaffolder Wizard           │
                        │  ┌─────────────────────────┐ │
                        │  │ ui:field: KagentSuggest │ │ ← new React component
                        │  │ [ Suggest ] button      │ │
                        │  │ Preview list w/ [Add]   │ │
                        │  └──────────┬──────────────┘ │
                        └─────────────┼────────────────┘
                                      │ POST /api/kagent-suggest/invoke
                                      ▼
                        ┌──────────────────────────────┐
                        │ Backstage Backend (in-cluster)│
                        │                              │
                        │  kagent-suggest backend       │ ← new module
                        │  module (HTTP route handler)  │
                        │      │                       │
                        │      ▼                       │
                        │  ┌─────────────────────────┐ │
                        │  │ kagent-shared library   │ │ ← extracted
                        │  │ • AgentResolver         │ │   from action
                        │  │ • A2AClient             │ │
                        │  │ • validateInvokeInput   │ │
                        │  └─────────────────────────┘ │
                        │      ▲                       │
                        │      │ (also consumed by)    │
                        │  ┌───┴──────────────────────┐│
                        │  │ kagent:agent:invoke      ││ ← existing
                        │  │ scaffolder action        ││   action
                        │  └──────────────────────────┘│
                        └──────────────┬───────────────┘
                                       │ (in-cluster A2A)
                                       ▼
                        ┌──────────────────────────────┐
                        │ kagent.dev Agent Service     │
                        │ *.kagent.svc.cluster.local   │
                        └──────────────────────────────┘
```

**Components:**

- **`KagentSuggest` React field extension** —
  `packages/app/src/scaffolder/KagentSuggestField/`. Renders the
  button + preview list. Reads `ui:options` for its config. Posts to
  the backend on click. Owns its loading/error UI state. Doesn't use
  its own field value — interacts with a different array field
  (`targetField`) via `formContext.onChange`.
- **`kagent-suggest` backend module** —
  `packages/backend/src/modules/kagent-suggest/`. One HTTP route
  handler: `POST /api/kagent-suggest/invoke`. Same auth as other
  Backstage routes (session cookie). Validates input, calls the shared
  library, returns JSON. ~80 lines.
- **`kagent-shared` library** —
  `packages/backend/src/modules/kagent-shared/`. `resolveAgent`,
  `invokeAgent`, `validateInvokeInput`, `AgentInvocationError`,
  `EndpointInfo`, `InvokeOptions`. Extracted from
  `kagentInvokeAction.ts`. Two consumers: the action and the new
  route. Pure refactor, no behavior change.

The action's 21 unit tests act as a safety net for the extraction:
running them after the refactor proves the resolver and invoker
semantics are preserved.

## 4. Backend route + shared library API

### HTTP endpoint

**`POST /api/kagent-suggest/invoke`**

Request body (JSON):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agentName` | string | yes | Catalog entity name. Validated against `^[a-z][a-z0-9-]{2,38}[a-z0-9]$`. |
| `prompt` | string | yes | 1..8000 chars. |
| `expectJson` | boolean | no | Default `false`. When `true`, the server parses and returns the object. |
| `timeoutMs` | integer | no | Default `60000`. Capped at `120000` (lower than the action's 300000 because users are waiting interactively). |

Response (JSON, always HTTP 200 except 401 from auth middleware):

```json
// Success
{
  "ok": true,
  "agentName": "skill-suggester",
  "runtime": "kagent",
  "durationMs": 5408,
  "response": "..."        // string, or parsed object when expectJson=true
}

// Failure
{
  "ok": false,
  "code": "AGENT_NOT_FOUND",
  "message": "No catalog entity 'component:default/skill-suggester'. Has the kagent Agent been ingested yet?"
}
```

**Why always-200:** the frontend treats this as a soft API. HTTP errors
get harder to handle in React (different code paths for network vs
application). A 200-with-`ok:false` collapses both into one path, and
the field renders the error inline as part of its UI. 401 is the only
non-200 (when the user has no session at all — Backstage's auth
middleware handles that before the route runs).

### Auth

The route is registered via `coreServices.httpRouter` and inherits the
backend's standard auth middleware. No additional permission checks in
v1 — anyone who can use the scaffolder can call this. Permissions can
layer on later via the Backstage Permission API.

### Shared library API

```typescript
// packages/backend/src/modules/kagent-shared/index.ts

export class AgentInvocationError extends Error {
  constructor(public code: string, message: string) { ... }
}

export interface EndpointInfo {
  endpoint: string;
  runtime: string;
  contractVersion: string;
}

export async function resolveAgent(
  discovery: DiscoveryService,
  name: string,
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
): Promise<EndpointInfo>;

export interface InvokeOptions {
  timeoutMs: number;
  stepId: string;     // becomes the JSON-RPC `id` field
}

export async function invokeAgent(
  endpoint: string,
  prompt: string,
  opts: InvokeOptions,
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
): Promise<string>;

export interface ValidatedInput {
  name: string;
  prompt: string;
  expectJson?: boolean;
  timeoutMs?: number;
  onError?: 'fail' | 'continue';
}

export function validateInvokeInput(
  raw: unknown,
  opts?: { maxTimeoutMs?: number },
): ValidatedInput;
```

The action and the route both call:

```typescript
const inputs = validateInvokeInput(raw, { maxTimeoutMs: 300000 /* or 120000 */ });
const info = await resolveAgent(discovery, inputs.name, logger);
const text = await invokeAgent(info.endpoint, inputs.prompt, { timeoutMs, stepId }, logger);
```

The only difference is what they do with the result and errors:
- The action emits scaffolder step outputs.
- The route emits a JSON response.

## 5. Frontend field — props and `ui:options` contract

### Field name: `KagentSuggest`

Registered via `createScaffolderFieldExtension` and added to the
scaffolder field extensions in `App.tsx`.

### Template usage

```yaml
parameters:
  - title: A2A Skills (optional)
    properties:
      skillSuggest:
        type: string                    # ignored — field renders without using this
        title: AI assist
        ui:field: KagentSuggest
        ui:options:
          agent: skill-suggester
          targetField: skills           # the form field to append into
          promptTemplate: |
            Suggest 3 A2A skills for an agent described as:
            "{{ description }}"
            Respond with ONLY a JSON array, no prose:
            [{"id":"kebab-case","name":"Title","description":"one sentence"}]
          watchFields: [description]    # form fields the template interpolates
          itemShape:                    # how each suggestion row renders
            id: text
            name: text
            description: text
          buttonLabel: Suggest skills
      skills:
        title: Skills
        type: array
        default: []
        items: { ... }                  # existing schema, unchanged
```

### `ui:options` contract

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | string | yes | Catalog name of the agent to call. |
| `targetField` | string | yes | Name of the form field (in the same parameters page or earlier) to append suggestions into. Must be an array field. |
| `promptTemplate` | string | yes | Mustache-style template. `{{ fieldName }}` placeholders are replaced from current form values before sending. |
| `watchFields` | string[] | no | Form fields referenced by `promptTemplate`. Used only to disable the Suggest button until all are non-empty. |
| `itemShape` | object | yes | Maps each property of the suggestion item to how it's rendered. Values: `text` or `multiline`. Drives both preview UI and edit affordance. |
| `buttonLabel` | string | no | Default `"Suggest"`. |
| `maxSuggestions` | integer | no | Default 10. Soft cap on preview list length; extras are discarded with a warn-level console log. |
| `timeoutMs` | integer | no | Default 60000. Passed through to the backend route. |

### Render layout

```
┌─ AI assist ───────────────────────────────────┐
│  [ Suggest skills ]   (disabled if "description" is empty) │
│                                                            │
│  Suggestions: (renders after a successful call)            │
│  ┌─────────────────────────────────────────┐ ┌─────┐       │
│  │ id: parse-text                          │ │ Add │       │
│  │ name: Parse Text                        │ └─────┘       │
│  │ description: Extracts entities from...  │               │
│  └─────────────────────────────────────────┘               │
│  ┌─────────────────────────────────────────┐ ┌─────┐       │
│  │ id: classify                            │ │ Add │       │
│  │ ...                                     │ └─────┘       │
│  └─────────────────────────────────────────┘               │
│                                                            │
│  [Loading spinner OR inline error message renders here]   │
└────────────────────────────────────────────────────────────┘
```

Each preview item is inline-editable before adding. Add appends the
(possibly edited) item to the target array. The preview list is not
cleared on Add — the user can edit and Add the same suggestion
multiple times, or keep adding the rest one by one. A small "✓ Added"
badge appears for ~2 seconds next to the row.

### Props

```typescript
interface KagentSuggestProps {
  uiSchema: { 'ui:options': KagentSuggestOptions };
  formContext: { formData: Record<string, unknown>; onChange: (data: any) => void };
  // (rjsf passes more props — only these matter for this field)
}
```

### Why `targetField` instead of mutating the field's own value

rjsf custom fields own their own value. A field that wants to mutate a
*different* array (the actual `skills` field) must call
`formContext.onChange` on the whole form with the merged target
array. The field's own value (the `skillSuggest` string) is set once
to `""` and never read; the `type: string` exists only to satisfy
schema validation.

## 6. Error handling and edge cases

### Backend error codes (always HTTP 200 with `ok:false`)

| Code | Source | Field rendering |
| --- | --- | --- |
| `AGENT_NOT_FOUND` | resolver | "Agent `<name>` is not in the catalog yet. Ask an operator to scaffold it before trying again." |
| `INVALID_CONTRACT` | resolver | "Agent `<name>` is missing the v1 annotation contract. Re-scaffold it through the IDP wizard." |
| `ENDPOINT_UNREACHABLE` | invoker | "Couldn't reach the agent service. Is the kagent namespace up?" |
| `INVOCATION_TIMEOUT` | invoker | "The agent didn't respond in `<n>`s. Try simplifying the prompt or retrying." |
| `AGENT_ERROR` | invoker | "The agent returned an error: `<code> <message>`. Check the agent's pod logs." |
| `INVALID_RESPONSE_JSON` | route | "The agent didn't return valid JSON. Either ask the operator to tune the agent's system message, or contact platform-eng." |
| `BAD_INPUT` | route | "Internal: the suggest field sent an invalid request. Reload the wizard." (shouldn't happen; safety net for typos in `ui:options`) |

All error states render in a MUI `Alert severity="warning"` below the
Suggest button. The button re-enables. No suggestions render. The
form's existing target array is **never mutated on error**.

### Input edge cases (guarded before calling)

1. **Missing watched field values** — Suggest button disabled with
   tooltip `"Fill in: <fieldName>"`.
2. **Identical re-click** — no caching; always re-call. LLM is
   non-deterministic and the user may want a fresh take.
3. **Click during loading** — button disabled while a request is
   in flight. No queueing.
4. **Component unmount during loading** — `AbortController` cancels
   the fetch. Cleans up the socket.

### Suggestion shape edge cases

1. **Agent returns non-array JSON** (single object) — auto-wrap as
   `[response]` if it matches `itemShape`. Otherwise show
   `"Agent returned a non-array response. Expected a list of {id, name, description}."`
2. **More than `maxSuggestions`** — silently truncate. Warn-level
   console log.
3. **Suggestion missing a required `itemShape` property** — skip that
   item, render the rest. Subtitle: `"1 suggestion was incomplete and skipped."`
4. **Empty suggestions array** — show
   `"The agent didn't suggest anything. Try a more specific description."`
   and re-enable the button.

### Concurrent edits

If the user edits `description` while a request is in flight, the
in-flight request continues with the *old* description. On success,
the preview shows what was actually requested. User can click Suggest
again with the new value. No magic — the field doesn't try to
auto-cancel-and-retry on form value changes.

### After Add

- Added item appended to the target form array via `formContext.onChange`.
- Preview list **remains unchanged** (allowing repeat adds with edits).
- "✓ Added" badge for ~2 seconds.
- Original form array is the source of truth. Preview is ephemeral
  state owned by the field, lost on page navigation or submit.

## 7. Testing strategy

Three layers.

### Layer 1 — backend unit tests

Lives at `packages/backend/src/modules/kagent-suggest/route.test.ts`
+ `packages/backend/src/modules/kagent-shared/*.test.ts`.

The route handler is thin (validate → call shared → emit JSON). Most
logic lives in the shared library, which already has 21 tests covering
resolver + invoker. After the refactor those tests **move** from
`kagentInvokeAction.test.ts` to `kagent-shared/`. Same assertions, same
fixtures, different file paths.

New route-specific tests (target: 8):

1. Happy path — POST with valid body returns `{ok:true, response, agentName, runtime, durationMs}`.
2. `expectJson: true` happy path — returns parsed object.
3. Schema rejection — missing `agentName` returns `BAD_INPUT`.
4. Schema rejection — `prompt` over 8000 chars returns `BAD_INPUT`.
5. Schema rejection — `timeoutMs` over 120000 returns `BAD_INPUT`.
6. Surface upstream errors — shared library throws `AgentInvocationError(AGENT_NOT_FOUND)` → route emits `{ok:false, code:'AGENT_NOT_FOUND', message}`.
7. Unauthenticated request — no session cookie returns 401.
8. CORS preflight — `OPTIONS /api/kagent-suggest/invoke` returns 204.

The action's own unit tests are reduced to orchestration-only
concerns (input parsing, output emission, `onError: continue`,
`expectJson` parsing). Resolver/invoker tests are no longer duplicated
in the action's file — they live with the shared library.

### Layer 2 — frontend unit tests

Lives at `packages/app/src/scaffolder/KagentSuggestField/KagentSuggestField.test.tsx`.

Uses `@testing-library/react` + `jest.spyOn(global, 'fetch')` to mock
the backend route. Test cases (target: 12):

1. Renders with disabled button when watched field is empty.
2. Enables button when watched field is non-empty.
3. Click → fetch goes to `/api/kagent-suggest/invoke` with the right body.
4. Mustache interpolation — `{{ description }}` is replaced from `formContext.formData.description`.
5. Loading state — button disabled with spinner during fetch.
6. Happy path — suggestions render as preview rows with editable inputs.
7. Add button — calls `formContext.onChange` with the merged target array.
8. Add twice — both calls append to the array (no dedupe).
9. Error rendering — `{ok:false, code:'AGENT_NOT_FOUND'}` shows the user-facing error, no suggestions render, button re-enables.
10. `INVALID_RESPONSE_JSON` shows the operator-action-required message.
11. Edit-then-Add — modifying preview row text before Add appends edited values.
12. Unmount during loading — AbortController is called.

### Layer 3 — manual operator validation

One-time, in the deployed cluster, with a real `skill-suggester` agent.
Steps recorded in the implementation plan:

1. Scaffold the `skill-suggester` agent via the existing kagent-agent
   template (one-time setup).
2. Modify the kagent-agent template's Skills page to include
   `ui:field: KagentSuggest`.
3. Open the kagent-agent wizard. Fill in name + description, navigate
   to Skills.
4. Click "Suggest skills". Verify suggestions render within ~10s.
5. Edit one suggestion's text. Click Add. Verify the skill appears in
   the Skills array below.
6. Submit the wizard. Verify the PR includes the added skill.
7. Record wall-clock duration, response quality, and any UX issues.

### What we deliberately don't test

- Visual regression / pixel-perfect rendering (low ROI for an internal
  tool field).
- LLM response quality (out of our control; depends on
  `skill-suggester`'s system message).
- Frontend-to-real-backend integration in CI (Layer 3 covers it
  manually).
- Concurrent users (the route is stateless; covered by the shared
  library's existing concurrency assumptions).

## 8. Rollout & security

### Rollout sequence (each step a separate commit, independently reversible)

1. **Refactor first.** Extract `kagent-shared/` from
   `kagentInvokeAction.ts`. Move 17 of 21 existing tests into the
   shared module. Keep 4 orchestration tests with the action. **No
   behavior change.** Validate by running the existing test suite.
2. **Add backend route.** Create `kagent-suggest/` module with the
   route handler and 8 new tests. Register via the New Backend System
   extension point alongside the scaffolder module. Validate with a
   `curl` from inside the cluster.
3. **Add frontend field.** Create `KagentSuggestField/` component,
   register via `<ScaffolderFieldExtensions>` in `App.tsx`. Validate
   with the 12 frontend unit tests. Dead code until a template uses it.
4. **Wire into kagent-agent template.** Add `ui:field: KagentSuggest`
   to the Skills page. This is what brings the feature to life.
5. **Layer 2 manual validation** in deployed cluster (gated on
   scaffolding `skill-suggester` agent).

Steps 1–3 ship dead code that doesn't affect any existing template.
Step 4 activates the feature. Step 5 is the live-fire test.

### Security

- **No new outbound traffic from the cluster.** Frontend → Backstage
  backend (same origin), backend → kagent agent (in-cluster Service).
  Identical network posture to the existing action.
- **Auth.** Route is behind standard backend auth middleware —
  anonymous returns 401. Anyone with a Backstage session who can use
  the scaffolder can call the route. v1 doesn't add finer-grained
  permissions; the route is no more privileged than running the
  kagent-agent template directly.
- **Prompt injection.** `promptTemplate` lives in template YAML
  (reviewed code, checked into Git). `{{ field }}` interpolation
  values come from the wizard's other form fields (typed by the user).
  Users can prompt-inject themselves. Since suggestion output is
  *never executed* — only added to the form for further user review —
  this is low-risk. The user is in the loop for both the prompt and
  the final form value.
- **Untrusted agent output.** Suggestions render as text in form
  inputs (React escapes by default). Items the user adds to the form
  go through the same form-validation gate as manually-entered items.
  No code paths execute the response.
- **Rate limiting.** Same `timeoutMs` cap as the action (120s here).
  No additional rate limit in v1. Tight-loop clicking throttles the
  user on the agent's response time.

### Forward compatibility

- `ui:options` are designed to grow. Adding new options (e.g.,
  `cacheTimeSeconds`, `maxRetries`, `successMessage`) is non-breaking.
- A `kagent-suggest:invoke-action` future variant could expose this
  same route via the scaffolder action system, enabling templates that
  want both styles. Out of scope for v1.
- If `crewai:agent:invoke` arrives, the shared library's
  `EndpointInfo.runtime` is the dispatch point. The route handler
  does the same dispatch as the action.

## 9. Out of scope (each is its own follow-up)

- **Streaming responses.** Route returns a single JSON payload. SSE +
  EventSource handling deferred.
- **Multi-turn conversations.** Each click is a fresh call. No
  conversation state.
- **Caching.** Each click hits the agent.
- **Auto-debounced trigger.** Decided against in brainstorm Q2.
- **Modal preview UI.** Decided against in brainstorm Q3.
- **Suggestion deduplication.** Repeat Adds with same content land
  twice. User can delete via existing form controls.
- **The `skill-suggester` agent itself.** This spec ships the field;
  the agent is a one-time scaffold the operator runs through the
  existing kagent-agent template. The implementation plan references
  the system message it should use.
- **Permissions API integration.** No per-user gating in v1.
- **Telemetry.** No analytics on usage. Could layer on later via the
  standard Backstage analytics API.

## 10. References

- `docs/superpowers/specs/2026-05-20-kagent-invoke-scaffolder-action-design.md` — the backend action this builds on.
- `docs/superpowers/plans/2026-05-20-kagent-invoke-scaffolder-action.md` — its implementation plan + Layer 2 validation result.
- `docs/guides/scaffolder-action-kagent-invoke.md` — operator guide for the action.
- `docs/guides/agent-annotation-contract-v1.md` — the annotation contract the shared library validates against.
- `packages/backend/src/modules/scaffolder/kagentInvokeAction.ts` — source of the resolver + invoker being extracted.
- Backstage docs: [Custom Scaffolder Field Extensions](https://backstage.io/docs/features/software-templates/writing-custom-field-extensions).

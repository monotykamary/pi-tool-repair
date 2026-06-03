# Tool-Call Grammar Leakage Survey (June 2026)

Survey of LLMs that use XML-like / sentinel-token tool-call grammars and are
observed to *leak* the raw markup into the user-visible `content` (or
`reasoning_content`) field instead of emitting structured `tool_calls`.

This is the input for an opt-in `pi-tool-repair` feature: a configurable,
**disabled-by-default** flag (set in `~/.pi/agent/extensions/pi-tool-repair.json`)
that recovers leaked grammar back into structured tool calls — or at minimum
strips it from visible output.

## Why leakage happens (root causes, consistent across families)

The same handful of mechanisms produce leakage regardless of vendor:

1. **Reasoning/tool-parser ordering.** When both a reasoning parser and a
   tool-call parser are enabled, the tool parser only runs on `content` after
   the reasoning parser yields. If the model emits the tool grammar *inside* an
   unclosed `<think>`/reasoning block, the tags land in `reasoning_content` and
   the tool parser never sees them. (DeepSeek, Qwen3.5/3.6, Kimi K2.)
2. **Split start-marker across stream chunks.** Long sentinel start tokens
   (`<｜｜DSML｜｜tool_calls>`, `<|tool_calls_section_begin|>`) get split across
   SSE chunks; the parser emits the partial prefix as plain text before it can
   recognize the marker. (DeepSeek DSML, Kimi K2, MiniMax.)
3. **`tool_choice=auto` + `stream=true`** is the high-risk path. `required` and
   `stream=false` are markedly more stable because they take a different
   (constrained) decode/parse branch.
4. **Tokenizer `skip_special_tokens=True` in batched decode.** When a tool-call
   request shares a batch with a non-tool request, the sentinel/special tokens
   get stripped, so the marker (`｜DSML｜`, `[TOOL_CALLS]`) is simply *missing*
   and downstream parsers fail. (DeepSeek V3.2, Mistral.)
5. **Provider/engine parser absent or mismatched.** Self-hosted vLLM/SGLang/MLX
   or aggregators (OpenRouter, Novita, Fireworks, NVIDIA, OpenCode Zen,
   Tensorix, Foundry) ship the model before a correct `--tool-call-parser`
   exists or with the wrong one, so raw markup passes straight through.
6. **Higher temperature** increases format drift away from the strict grammar.

Prompt-level mitigations ("do not output DSML tags") are unreliable: emission is
a tokenizer/training-level pattern, not instruction-following.

## The grammar families to handle

These are the concrete shapes that show up in leaked `content`. Group them by
parser, not by vendor — multiple vendors share a shape.

### A. DeepSeek "DSML" XML (`｜DSML｜`, U+FF5C fullwidth bars)

DeepSeek V3.2 / V4 (V4-Pro, V4-Flash). The `｜` is U+FF5C fullwidth vertical bar.
Three observed bar variants plus an ASCII-pipe variant from some proxies:

```
# Double-bar (most common in live V4 SSE)
<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="code_exec">
<｜｜DSML｜｜parameter name="language" string="true">python</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>

# Single-bar
<｜DSML｜tool_calls>
<｜DSML｜invoke name="fetch">
<｜DSML｜parameter name="url" string="false">["x"]</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>

# No-leading-bar
<DSML｜tool_calls>
<DSML｜invoke name="bash">
</DSML｜invoke>

# ASCII-pipe variant (proxies/aggregators that transcode the fullwidth bars)
< | DSML | tool_calls>
< | DSML | invoke name="builtin_web_search">
< | DSML | parameter name="additionalContext" string="true">...</ | DSML | parameter>
</ | DSML | invoke>
</ | DSML | tool_calls>
```

Key details:
- `function_calls` vs `tool_calls` both appear as the outer wrapper (V3.2 used
  `function_calls`; V4 uses `tool_calls`). Handle both, singular and plural.
- `string="true"` → value passed as-is; `string="false"` → value is JSON
  (number/bool/array/object). The repair must respect this when building args.
- Inner body can be XML `<parameter>` tags **or** a direct JSON object.
- Newlines inside `<parameter>` values are common (multi-line bash) and break
  naive non-DOTALL matching — a real failure mode reported against pi itself
  (earendil-works/pi#3712).
- Providers with reported leakage: official DeepSeek API, **NVIDIA**,
  **Novita**, **Fireworks**, **OpenCode Zen**, **Tensorix**, Microsoft Foundry,
  CherryIN, self-hosted vLLM/SGLang/antirez-ds4.

### B. Anthropic-style `<invoke>` / `<parameter>` XML (no DSML bars)

This is the canonical Anthropic tool-use shape, widely copied. Leaked by:

- **MiniMax** M1, M2.1, M2.5, M2.7, M3 — wrapped in `<minimax:tool_call>`:
  ```xml
  <minimax:tool_call>
  <invoke name="search_web">
  <parameter name="query_list">["..."]</parameter>
  </invoke>
  </minimax:tool_call>
  ```
  MiniMax M2 also has a *malformed* variant that drops the `<`/`</` angle
  brackets entirely (`invoke name="x">` … `parameter name="y">val parameter>`),
  needing bracket-repair before XML parsing.
- **Anthropic Claude via OpenRouter** occasionally emits raw `<tool_call>` /
  `<tool_result>` tags as text.
- Generic `<tool_call>...</tool_call>` and `<tool_result>...</tool_result>`
  blocks leaked across many OpenAI-compat providers.

### C. Qwen / Hermes XML (`<tool_call>` + `<function=…>` + `<parameter=…>`)

Two sub-shapes — note the `=` (Qwen3-Coder/qwen3_xml) vs `name="…"` (Hermes):

```xml
# Qwen3-Coder / qwen3_xml shape (attribute via '=')
<tool_call>
<function=get_weather>
<parameter=location>Paris</parameter>
</function>
</tool_call>

# Hermes shape (JSON inside <tool_call>)
<tool_call>
{"name": "get_weather", "arguments": {"location": "Paris"}}
</tool_call>

# Qwen2.5-Coder oddball: wraps in <tools> with a JSON body
<tools>
{"name": "get_weather", "arguments": {"location": "San Francisco, CA"}}
</tools>
```

Affected: Qwen2.5 / Qwen2.5-Coder / Qwen2.5-VL, QwQ-32B, Qwen3 / Qwen3-Coder
(30B, 480B, Next), **Qwen3.5** (9B/35B-A3B most unstable), **Qwen3.6**
(27B / 35B-A3B). Common failure: XML lands in `reasoning_content` when emitted
inside an unclosed `<think>`. Also malformed variants (merged tags
`<function=edit>` missing `<`, bare `<function>` without `<tool_call>`,
mismatched/missing closers) — see the community `qwen-toolcall-fixer` proxy.

### D. Kimi K2 sentinel tokens (`<|tool_calls_section_begin|>` …)

Moonshot Kimi K2 / K2-Thinking / K2.6:

```
<|tool_calls_section_begin|>
<|tool_call_begin|>functions.web_search:0<|tool_call_argument_begin|>{"query": "..."}<|tool_call_end|>
<|tool_calls_section_end|>
```

Details:
- Singular variants also exist: `<|tool_call_section_begin|>` / `_end`.
- Tool-call ID format is load-bearing: `functions.{name}:{idx}`. Bare
  `call00003` / `search:2` / `call_0001` (OpenAI-style) confuse the model and
  the parser, causing leakage or empty `tool_calls`. Hosted Moonshot API
  normalizes IDs; OSS deployments must normalize client-side.
- Leaks into `reasoning_delta`/`reasoning_content` in thinking mode.
- Sparse toolsets (1–2 tools) increase the inline-token leakage rate
  (observed via OpenRouter for `moonshotai/kimi-k2.6`).

### E. Mistral sentinel tokens (`[TOOL_CALLS]`, `[ARGS]`, `[CALL_ID]`)

Mistral 7B v0.3, Nemo, Ministral-8B, Mistral-Large-2407, plus V7/V11 tokenizers:

```
[TOOL_CALLS] [{"name": "calculator", "arguments": {"operation": "2+2"}, "id": "VvvODy9mT"}]
# V11: [TOOL_CALLS]name[CALL_ID]id[ARGS]{...}
```

Failure modes: tool call emitted as plain JSON text (no `[TOOL_CALLS]` token),
`skip_special_tokens` dropping the sentinel, brittle behavior above temperature
0, IDs must be 9-char alphanumeric.

### F. Llama `<|python_tag|>` + JSON / pythonic

Llama 3.1 / 3.2 / 3.3 / 4. Tool call prefixed with `<|python_tag|>`, body is
JSON (`llama3_json` / `llama4_json`) or pythonic (`pythonic` / `llama4_pythonic`).
Leaks when the `<|python_tag|>` token is dropped or the model wraps JSON in
markdown / adds preamble text. Llama 3.2 emits *no* start token at all, which is
its own leakage class.

### G. GLM `<tool_call>` + `<arg_key>` / `<arg_value>` XML

Zhipu/Z.ai GLM-4.5 / GLM-4.6 / GLM-4.7 (`glm4_moe` / `glm47` parser), and
GLM-5:

```xml
<tool_call>get_weather
<arg_key>city</arg_key>
<arg_value>Beijing</arg_value>
</tool_call>
```

Reasoning wrapped in `<think>`/`</think>`. Zero-arg calls
(`<tool_call>get_current_date</tool_call>`) and same-line name+args are valid
variants. GLM-5 observed leaking raw `<tool_call>` shadow text to chat channels.

### H. IBM Granite `<tool_call>` + JSON (Hermes-derived)

Granite 4.0 / 4.1 (and Nano). Uses Hermes convention:
`<tool_call>{"name": …, "arguments": …}</tool_call>`. Known quirk: emits
arguments as an escaped *string* instead of JSON object. Granite 3.3 / 4.0
H-Small emit *pythonic* calls (`func(kw=val)`) instead — a separate shape.

### I. MiniMax-Text-01 typescript-style

Older MiniMax text model emits:
```
<function_call>```typescript
functions.get_current_weather({"location": "Shanghai"})
```
```

### J. OLMo 3 `<function_calls>` + pythonic

AllenAI OLMo 3 Instruct: newline-delimited pythonic calls wrapped in
`<function_calls>...</function_calls>` (allows JSON `true`/`false`/`null`).
(OLMo 3 *Think* models are not trained for tools — leakage there is the model
narrating, not a grammar.)

## Quick reference table

| Family | Models | Marker shape | Inner body | Leaks into |
|---|---|---|---|---|
| A. DSML | DeepSeek V3.2, V4-Pro, V4-Flash | `<｜DSML｜tool_calls>` / `function_calls` (+ double-bar, no-bar, ASCII `< | DSML |`) | `<parameter name= string=>` or JSON | content + reasoning |
| B. invoke/parameter | MiniMax M1–M3, Claude (via OpenRouter) | `<minimax:tool_call>` / `<invoke name=>` `<parameter name=>` | text / JSON | content |
| C. Qwen/Hermes | Qwen2.5/3/3.5/3.6, Coder, VL, QwQ | `<tool_call>` + `<function=>` `<parameter=>` or JSON | text / JSON | reasoning_content |
| D. Kimi sentinels | Kimi K2 / K2-Thinking / K2.6 | `<\|tool_calls_section_begin\|>` … | `functions.name:idx` + JSON | content + reasoning_delta |
| E. Mistral sentinels | 7B v0.3, Nemo, Ministral, Large-2407 | `[TOOL_CALLS]` `[ARGS]` `[CALL_ID]` | JSON array | content |
| F. Llama python_tag | Llama 3.1/3.2/3.3/4 | `<\|python_tag\|>` (or none) | JSON / pythonic | content |
| G. GLM arg_key | GLM-4.5/4.6/4.7, GLM-5 | `<tool_call>name` + `<arg_key>` `<arg_value>` | XML kv | content + think |
| H. Granite | Granite 4.0/4.1 (+ Nano) | `<tool_call>` | JSON (sometimes escaped string) | content |
| I. MiniMax-Text-01 | MiniMax-Text-01 | `<function_call>` ```typescript | `functions.x({...})` | content |
| J. OLMo3 | OLMo 3 Instruct | `<function_calls>` | newline pythonic | content |

## Provider hot-spots (where leakage is reported in the wild)

Aggregators/engines that have shipped models ahead of (or without) a correct
parser, producing the leakage the colleague observed:

- **Novita, Fireworks, OpenCode Zen, Tensorix** — reported by colleague for
  DeepSeek V4-Flash.
- **NVIDIA** integrate endpoint — DSML leaked as assistant text (DeepSeek V4).
- **OpenRouter** — Kimi K2.6 inline tokens (sparse toolsets), Claude raw tags.
- **Microsoft Foundry / CherryIN** — DeepSeek V4 DSML.
- Self-hosted **vLLM / SGLang / MLX / llama.cpp / Ollama** across all families
  (parser version mismatches, batched-decode special-token stripping).

## Design implications for the opt-in flag

1. **Disabled by default**, configured at
   `~/.pi/agent/extensions/pi-tool-repair.json`. Likely shape:
   ```json
   {
     "grammarRepair": {
       "enabled": true,
       "grammars": ["dsml", "minimax", "qwen", "kimi", "mistral", "llama", "glm", "granite", "olmo"],
       "mode": "recover"  // "recover" = promote to tool_calls; "strip" = remove from visible text only
     }
   }
   ```
   Default to all-known grammars when `enabled` and `grammars` omitted; allow
   per-grammar opt-in/out.

2. **Recover, don't just strip.** Stripping alone leaves the agent loop with
   `finish_reason: stop` and no tool dispatched (silent no-op). The valuable
   behavior is parsing the leaked grammar into structured tool calls and
   rewriting `finish_reason` → `tool_calls` (the path Cherry Studio, OpenClaw,
   and Hermes all converged on). Fall back to strip when the block is malformed.

3. **Only recover complete, well-formed blocks with a known tool name and
   parseable args.** Leave incomplete/malformed markup as text (or surface a
   parse error) — do not promote arbitrary prose into execution.

4. **Stream-aware buffering.** Markers split across chunks; buffer a bounded
   prefix (marker-length window) before emitting visible text, with a cap
   (Kimi parser uses ~1KB buffer / 8KB section cap) and a final flush.

5. **Respect DSML `string="true|false"`** when building arguments; unwrap nested
   `{"arguments": "{...}"}` wrappers; normalize Kimi tool-call IDs to
   `functions.{name}:{idx}`.

6. **Code-fence / prose guard.** Don't strip grammar that appears inside fenced
   code blocks or when the user/assistant is legitimately discussing the syntax
   (the bug OpenClaw hit with `stripToolCallXmlTags`).

7. **Match the colleague's exact three DSML variants first** (double-bar,
   single-bar, no-lead-bar), then generalize to the table above.

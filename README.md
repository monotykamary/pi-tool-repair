<div align="center">

# 🔧 pi-tool-repair

**Validate-then-repair for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Fixes the finite set of tool-call mistakes open models make — before tools execute._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

> **Open models aren't bad at tool calling — the harness is.**
>
> By adding a thin repair layer, DeepSeek V4 Pro beat Opus 4.7 in 6/10 internal evals — without changing the model. The same four mistakes repeat across DeepSeek, GLM, Qwen, and others. Each fix is 30–100 lines. Order matters.

## What it fixes

| Problem | Model sends | After repair |
| ------- | ----------- | ------------ |
| `null` for optional fields | `{"path":"/foo","offset":null}` | `{"path":"/foo"}` |
| Arrays as JSON strings | `{"edits":"[{...}]"}` | `{"edits":[{...}]}` |
| `{}` where an optional array is expected | `{"include":{}}` | _(dropped)_ |
| Bare string where an array is expected | `{"include":"foo"}` | `{"include":["foo"]}` |
| Wrong field names | `{"file_path":"/foo"}` | `{"path":"/foo"}` |
| Numeric strings | `{"limit":"20"}` | `{"limit":20}` |
| Bare string as root input | `"/path/to/file"` | `{"path":"/path/to/file"}` |
| `fabric_exec` code arrays | `{"code":["const x=1;","return x;"]}` | newline-joined `code` |
| Schema anchor bleed (Kimi K2) | `"^pattern$"` in values | `"pattern"` |
| Leaked tool grammar (opt-in) | `<｜DSML｜tool_calls>...` | pi `toolCall` block |
| Phantom tool use | `stopReason:"toolUse"` with no call | retryable error |

## Install

**With `pi install`** (recommended):

```bash
pi install npm:pi-tool-repair
```

Or install from GitHub:

```bash
pi install https://github.com/monotykamary/pi-tool-repair
```

**With npm**:

```bash
npm install npm:pi-tool-repair
```

**Manual** — add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/monotykamary/pi-tool-repair"]
}
```

**Local development** — add the extension path directly:

```json
{
  "extensions": ["./path/to/pi-tool-repair/tool-repair.ts"]
}
```

Reload with `/reload` after any install method.

## How it works

```text
before_provider_request
  └─ model-gated schema anchor sanitization

model response → message_end
  ├─ strip leaked grammar tokens from native toolCall blocks
  ├─ recover complete leaked grammar calls when enabled
  ├─ validate raw arguments against each active tool's live schema
  ├─ apply only known aliases and schema-directed repairs
  ├─ commit a candidate only when it re-validates
  └─ turn phantom toolUse responses into retryable errors

Pi then runs its normal prepare → validate → execute pipeline
```

Pi 0.84 validates tool arguments before emitting `tool_call`. Repair therefore runs on the finalized assistant message, while the provider's raw arguments are still available and before Pi's validation can reject or coerce them.

### Repair rules

| Rule | What it catches |
| ---- | --------------- |
| `renameAliasedField` | `file_path` → `path`, `query` → `pattern`, option aliases, etc. |
| `dropNullOrUndefined` | `null`/`undefined` for schema-optional fields |
| `dropEmptyObjectPlaceholder` | `{}` where an optional array is expected |
| `parseJsonStringifiedArray` | `"[\"a\",\"b\"]"` → `["a","b"]` |
| `wrapBareStringAsArray` | `"foo"` → `["foo"]` when the schema expects an array |
| `wrapRootStringAsObject` | `"/path"` → `{"path":"/path"}` for known string-primary tools |
| `coerceNumericString` | `"20"` → `20` when the live schema expects a number |
| `convertTimeoutMilliseconds` | `timeoutMs` → `timeout` seconds for `bash` |
| `joinStringArray` | all-string `fabric_exec.code` arrays → one newline-joined string |

### Why validate-then-repair

The extension reads the schemas from `pi.getAllTools()` instead of maintaining a parallel copy. Schema-valid input with no known compatibility aliases is returned unchanged. Invalid input is cloned, repaired only at schema-declared fields, and revalidated; an unrepairable candidate is discarded so Pi reports the original error. Canonical fields win when both canonical and alias spellings are present.

## Configuration

### Grammar leak repair (disabled by default)

Raw XML/sentinel tool-call grammar recovery is opt-in because it can turn assistant text into tool execution. Enable it in `~/.pi/agent/extensions/pi-tool-repair.json`:

```json
{
  "grammarRepair": {
    "enabled": true,
    "mode": "recover",
    "requireKnownTool": true,
    "grammars": [
      "dsml",
      "invoke",
      "qwen",
      "kimi",
      "mistral",
      "llama",
      "glm",
      "granite",
      "minimax-text",
      "olmo"
    ]
  }
}
```

Modes:

| Mode      | Behavior                                                       |
| --------- | -------------------------------------------------------------- |
| `recover` | Strip leaked markup and append recovered pi `toolCall` blocks. |
| `strip`   | Strip leaked markup only; do not execute recovered calls.      |

#### Per-model enablement

If only some of your models leak grammar — common with local servers such as llama.cpp, vLLM, or Ollama — auto-enable recovery per model id with `leakModels`. Entries are case-insensitive regex fragments matched against the active model id:

```json
{
  "grammarRepair": {
    "leakModels": ["kimi", "qwen3", "gguf"]
  }
}
```

Recovery turns on whenever the session's model id matches a pattern. Global `enabled: true` takes precedence over `leakModels`, so models with reliable native tool calling stay untouched. Regex entries that fail to compile are ignored.

#### What the model sees on the next request

Every repair runs on pi's `message_end` hook, where the repaired message is replaced in place — the corrected call, not the model's original output, is what pi writes to the session file and resends on later requests. With `mode: "recover"`, leaked tool-call text is likewise converted into real `toolCall` blocks before persistence, so subsequent requests show the model a properly formed call plus its tool results: an in-context correction loop instead of a silent execute-time patch. Local models benefit the most since there is no prompt-cache penalty for the rewritten history; providers that cache by prefix may treat the first turn after a repair as a cache miss.

Safety gates:

- `requireKnownTool: true` only recovers calls whose name is in pi's active tool registry.
- Markup inside fenced code blocks is ignored so syntax discussions and examples are preserved.
- Incomplete or unparseable blocks are not recovered as tool calls. For DSML, dangling or truncated marker tokens (e.g. a stream that died at `<｜DSML｜tool_calls` with no closing `>`) are still stripped from visible text so the raw marker doesn't persist in the transcript.
- If the provider already emitted native `toolCall` blocks, leaked shadow text is stripped but duplicate calls are not added.

Covered grammar families: DeepSeek DSML, MiniMax/Anthropic `<invoke>`, Qwen/Hermes `<tool_call>`, Kimi sentinels, Mistral `[TOOL_CALLS]`, Llama `<|python_tag|>`, GLM `arg_key`/`arg_value`, Granite JSON `<tool_call>`, MiniMax-Text-01 TypeScript calls, and OLMo3 `<function_calls>` pythonic calls. See [`docs/tool-call-grammar-leakage-survey.md`](./docs/tool-call-grammar-leakage-survey.md) for the survey.

### Debug logging

Set `PI_TOOL_REPAIR_DEBUG=1` or `grammarRepair.debug: true` to log repair diagnostics to stderr:

```
[pi-tool-repair] tool=read outcome=recovered rules=dropNullOrUndefined hints=1
  input: {"path":"/foo","offset":null}
  repaired: {"path":"/foo"}
  hint[0]: Dropped null `offset` from tool "read"...
```

### Covered tools

Schema-directed null, array, and numeric repairs apply to every active tool whose live schema Pi exposes. The curated alias table covers Pi's built-in `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools. `fabric_exec` root strings and all-string `code` arrays are also supported.

### Pi Fabric compatibility

With Pi Fabric full code mode, `pi-tool-repair` sees `fabric_exec` as the active model-facing tool. It repairs the outer call, leaked provider grammars, anchor bleed, and phantom tool-use responses before Pi validation. Nested `pi.*` calls are created later by Fabric's TypeScript guest, so Fabric owns their alias and optional-null normalization before its registry validation. No duplicate tool registration or wrapper is required.

### Anchor bleed models

Phase 0 schema sanitization activates for models matching these patterns:

| Pattern           | Models                              |
| ----------------- | ----------------------------------- |
| `/kimi-k2/i`      | Kimi K2 variants                    |
| `/moonshotai\/kimi/i` | Moonshot Kimi (direct API)      |
| `/@cf\/.*kimi/i`  | @cf Kimi (e.g. `@cf/moonshotai/kimi-k2.6`) |
| `/minimax/i`      | MiniMax variants                    |
| `/glm/i`          | GLM variants                        |

To add more models, edit `anchorBleedModels` in [`src/index.ts`](./src/index.ts).

### Field aliases

The extension maps common model mistakes (wrong field names) to the canonical field name. For example, when calling `read`, the model can send `file_path`, `absolutePath`, `filepath`, `target_file`, etc. — all map to `path`.

<details>
<summary><strong>Alias summary</strong></summary>

| Tool | Canonical | Aliases |
| ---- | --------- | ------- |
| `read` | `path` | `absolutePath`, `file_path`, `filePath`, `filepath`, `pathname`, `target_file`, `targetFile`, `file`, `absolute_path`, `fileAbsolutePath` |
| `read` | `offset`, `limit` | `start`, `max` |
| `grep` | `pattern` | `query`, `regex`, `search`, `q`, `expression`, `text` |
| `grep` | `glob`, `ignoreCase`, `context`, `limit` | `globPattern`, `ic`, `caseInsensitive`, `ctx`, `max` |
| `write` | `path`, `content` | path aliases above; `text`, `body`, `data`, `contents`, `fileContent` |
| `edit` | `path` | path aliases above |
| `edit` | `oldText` | `old_string`, `oldString`, `old`, `old_str`, `oldStr`, `from`, `old_value`, `old_text`, `oldContent`, `old_content` |
| `edit` | `newText` | `new_string`, `newString`, `new`, `replacement`, `new_str`, `newStr`, `to`, `new_value`, `new_text`, `newContent`, `new_content` |
| `ls` | `path`, `limit` | path aliases plus `directory`, `dir`, `folder`, `directoryPath`; `max` |
| `find` | `pattern`, `limit` | `query`, `regex`, `glob`, `expression`, `search`, `include`, `name`, `filename`; `max` |
| `bash` | `command` | `cmd`, `shell`, `cmdline`, `script`, `commandLine` |

</details>

## Development

```bash
pnpm install
pnpm test              # run tests
pnpm run test:watch    # watch mode
pnpm run test:coverage # coverage report
pnpm run typecheck     # type checking
pnpm run lint:dead     # dead code detection
```

## Related projects

| Project                                                                        | Description                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [pi-retry](https://github.com/monotykamary/pi-retry)                           | Automatic retry for 400/413/connection errors               |
| [pi-fast-resume](https://github.com/monotykamary/pi-fast-resume)               | Instant session picker (6ms vs 5.6s)                        |
| [pi-hide-providers](https://github.com/monotykamary/pi-hide-providers)         | Hide providers and models from the selector                 |
| [pi-double-esc](https://github.com/monotykamary/pi-double-esc)                 | Prevent accidental Escape aborts                            |
| [pi-loop](https://github.com/monotykamary/pi-loop)                             | Close the verification loop on task completion              |
| [pi-fireworks-provider](https://github.com/monotykamary/pi-fireworks-provider) | Fireworks AI provider (origin of the Kimi anchor-bleed fix) |

## License

[MIT](./LICENSE)

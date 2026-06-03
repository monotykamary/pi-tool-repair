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

Reverse-engineered from [Command Code](https://commandcode.ai/)'s tool parsing pipeline.
## What it fixes

| Problem                       | Model sends                        | After repair                |
| ----------------------------- | ---------------------------------- | --------------------------- |
| `null` for optional fields    | `{"path": "/foo", "offset": null}` | `{"path": "/foo"}`          |
| Arrays as JSON strings        | `"[\"a\",\"b\"]"`                  | `["a","b"]`                 |
| `{}` where array expected     | `{"include": {}}`                  | _(dropped)_                 |
| Bare string → array           | `"foo"`                            | `["foo"]`                   |
| Wrong field names             | `{"file_path": "/foo"}`            | `{"path": "/foo"}`          |
| Bare string as root input     | `"/path/to/file"`                  | `{"path": "/path/to/file"}` |
| Schema anchor bleed (Kimi K2) | `"^pattern$"` in values            | `"pattern"`                 |

## Install

**With `pi install`** (recommended):

```bash
pi install git:github.com/monotykamary/pi-tool-repair
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

```
┌────────────────────────────────────────────────────────────┐
│ Phase 0: Schema poisoning (before_provider_request)        │
│                                                            │
│ Strip regex anchors from JSON Schema patterns for models   │
│ where they leak into generated values (Kimi K2, MiniMax)   │
│                                                            │
│ Fixes what YOU send the model — not what the model sends   │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
               Model generates tool call
                           │
                           ▼
┌────────────────────────────────────────────────────────────┐
│ Phase 2: Validate-then-repair (tool_call)                  │
│                                                            │
│  1. Validate input against schema (if known tool)          │
│   ↳ Valid? Ship it untouched.                              │
│  2. Walk the validator's issue list                        │
│   ↳ Apply targeted repairs only at the exact failed paths  │
│  3. Re-validate the repaired input                         │
│   ↳ Still invalid? Let the tool handle it.                 │
│  4. Log outcome (debug mode)                               │
└────────────────────────────────────────────────────────────┘
```

### Repair rules (in order)

Order matters — `parseJsonStringifiedArray` must run before `wrapBareStringAsArray` or you get double-wrapping.

| #   | Rule                         | What it catches                                 |
| --- | ---------------------------- | ----------------------------------------------- |
| 1   | `renameAliasedField`         | `file_path` → `path`, `query` → `pattern`, etc. |
| 2   | `dropNullOrUndefined`        | `null`/`undefined` for optional fields          |
| 3   | `dropEmptyObjectPlaceholder` | `{}` where array expected                       |
| 4   | `parseJsonStringifiedArray`  | `"[\"a\",\"b\"]"` → `["a","b"]`                 |
| 5   | `wrapBareStringAsArray`      | `"foo"` → `["foo"]`                             |
| 6   | `wrapRootStringAsObject`     | `"/path"` → `{"path": "/path"}`                 |

### Why validate-then-repair (not preprocess-then-validate)

Preprocessing inputs before validation silently corrupts valid data — rewriting file content that happened to look like JSON, for example. The better design:

1. **Parse the input as-is.** If valid, ship it untouched.
2. **On failure, walk the validator's issue list** and apply repairs only at the exact paths that failed.
3. **Re-validate.** The schema localizes the bug for you — you only spend repair effort where it's actually needed.

## Configuration

### Debug logging

Set `PI_TOOL_REPAIR_DEBUG=1` to log repair diagnostics to stderr:

```
[pi-tool-repair] tool=read outcome=recovered rules=dropNullOrUndefined hints=1
  input: {"path":"/foo","offset":null}
  repaired: {"path":"/foo"}
  hint[0]: Dropped null `offset` from tool "read"...
```

### Covered tools

Repair rules apply to pi's built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.

### Anchor bleed models

Phase 0 schema sanitization activates for models matching these patterns:

| Pattern      | Models           |
| ------------ | ---------------- |
| `/kimi-k2/i` | Kimi K2 variants |
| `/minimax/i` | MiniMax variants |
| `/glm/i`     | GLM variants     |

To add more models, edit `anchorBleedModels` in [`src/index.ts`](./src/index.ts).

### Field aliases

The extension maps common model mistakes (wrong field names) to the canonical field name. For example, when calling `read`, the model can send `file_path`, `absolutePath`, `filepath`, `target_file`, etc. — all map to `path`.

<details>
<summary><strong>Full alias table</strong></summary>

| Tool    | Canonical | Aliases                                                                                                                                   |
| ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `path`    | `absolutePath`, `file_path`, `filePath`, `filepath`, `pathname`, `target_file`, `targetFile`, `file`, `absolute_path`, `fileAbsolutePath` |
| `grep`  | `pattern` | `query`, `regex`, `search`, `q`, `expression`, `text`                                                                                     |
| `write` | `path`    | `absolutePath`, `file_path`, `filePath`, `filepath`, `pathname`, `target_file`, `targetFile`                                              |
| `write` | `content` | `text`, `body`, `data`, `contents`, `fileContent`                                                                                         |
| `edit`  | `path`    | `absolutePath`, `file_path`, `filePath`, `filepath`, `pathname`, `target_file`, `targetFile`                                              |
| `edit`  | `oldText` | `old_string`, `oldString`, `old`, `old_str`, `oldStr`, `from`, `old_value`, `oldText`, `old_text`, `oldContent`, `old_content`            |
| `edit`  | `newText` | `new_string`, `newString`, `new`, `new_str`, `newStr`, `to`, `new_value`, `newText`, `new_text`, `newContent`, `new_content`              |
| `ls`    | `path`    | `absolutePath`, `directory`, `dir`, `folder`, `directoryPath`                                                                             |
| `find`  | `pattern` | `query`, `glob`, `expression`, `search`, `include`                                                                                        |
| `bash`  | `command` | `cmd`, `shell`, `script`, `commandLine`                                                                                                   |

</details>

## Development

```bash
npm install
npm test              # run tests (59 tests)
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run typecheck     # type checking
npm run lint:dead     # dead code detection
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

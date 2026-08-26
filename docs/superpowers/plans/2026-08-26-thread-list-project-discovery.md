# Thread-list Project Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover project directories from Codex App Server `thread/list` history and merge them into the Feishu bridge project selector without breaking manual configuration.

**Architecture:** Add a small, testable App Server JSON-RPC client that starts `codex app-server` on demand, initializes the protocol, paginates non-archived and archived `thread/list` results, and extracts valid `cwd` values. Keep manual `DEFAULT_PROJECT_PATH` and `CODEX_PROJECTS` as the baseline, merge discovered paths by normalized absolute path, and refresh the in-memory selector on startup, `/panel`, `/project`, and card refreshes. Discovery failures are logged and leave the manual list usable.

**Tech Stack:** Node.js 18+, `node:child_process`, newline-delimited JSON-RPC over `codex app-server`, Node built-in test runner, PowerShell local process verification.

**Spec:** User request: implement方案二（通过 `thread/list` 间接发现项目）。

## Global Constraints

- Preserve the existing `DEFAULT_PROJECT_PATH` and `CODEX_PROJECTS` behavior.
- Never let App Server discovery failure prevent the Feishu bridge from starting or serving manually configured projects.
- Only include non-empty absolute directories that exist on the local filesystem.
- Use bounded timeouts and terminate the short-lived App Server child after discovery.
- Do not expose credentials or modify unrelated files.
- Commit and push only the scoped implementation, tests, plan, and documentation changes to `main`.

---

### Task 1: Define pure discovery parsing and merge behavior

**Files:**
- Modify: `bridge-core.mjs`
- Test: `test/bridge-core.test.mjs`

**Interfaces:**
- Produces `extractThreadCwds(payload)` returning valid raw `cwd` strings from a `thread/list` response.
- Produces `mergeProjectChoices(baseChoices, discoveredPaths, options)` returning deduplicated `{ alias, path }` choices while preserving base order.

- [x] **Step 1: Write failing tests** for extracting `cwd`, handling malformed entries, pagination response shapes, and preserving manual choices while appending discovered directories.
- [x] **Step 2: Run `node --test test/bridge-core.test.mjs` and confirm the new tests fail because the exports do not exist.
- [x] **Step 3: Implement the minimal pure helpers in `bridge-core.mjs`.
- [x] **Step 4: Run the focused tests and confirm they pass.

### Task 2: Implement the short-lived Codex App Server client

**Files:**
- Create: `codex-projects.mjs`
- Test: `test/codex-projects.test.mjs`

**Interfaces:**
- Produces `discoverCodexProjectPaths({ codexBin, timeoutMs, spawnImpl })` returning `Promise<string[]>`.
- The client sends `initialize`, then paginated `thread/list` calls for `archived: false` and `archived: true`.
- The client accepts line-delimited JSON-RPC responses, matches response IDs, rejects protocol errors/timeouts, and kills the child process in all terminal paths.

- [x] **Step 1: Write failing tests** using a deterministic fake spawn stream for request ordering, both archive filters, pagination, malformed lines, protocol errors, and timeout/cleanup behavior.
- [x] **Step 2: Run the focused tests and confirm they fail because the client module does not exist.
- [x] **Step 3: Implement the minimal JSON-RPC client with injected process spawning and bounded timeout.
- [x] **Step 4: Run the focused tests and confirm they pass.

### Task 3: Integrate discovery into bridge configuration and refresh paths

**Files:**
- Modify: `bridge.mjs`
- Modify: `setup.ps1`
- Modify: `README.md`
- Test: `test/bridge-core.test.mjs` and `test/codex-projects.test.mjs`

**Interfaces:**
- Add `CODEX_PROJECT_DISCOVERY` (default `thread-list`) and `CODEX_PROJECT_DISCOVERY_TIMEOUT` (default `15000`) configuration.
- Keep `config.bridge.manualProjectChoices` separate from mutable `config.bridge.projectChoices`.
- Add `refreshProjectChoices()` that discovers paths, merges them, updates aliases, and logs failures without throwing.
- Invoke refresh before `/panel`, `/project` responses, and card `refresh` / `show_sessions` redraws; perform one best-effort startup refresh and a bounded periodic refresh.

- [x] **Step 1: Add tests for merge behavior and disabled/failure-safe discovery configuration.
- [x] **Step 2: Run the affected tests and confirm the new integration expectations fail.
- [x] **Step 3: Implement config loading, refresh, panel integration, setup propagation, and README documentation.
- [x] **Step 4: Run the full Node test suite and syntax checks.

### Task 4: Verify with the local Codex process and deliver

**Files:**
- Inspect only: `bridge.mjs`, `codex-projects.mjs`, `bridge-core.mjs`, tests, and generated config as needed.

- [x] **Step 1: Run the real `codex app-server` discovery path against the installed local Codex CLI and record discovered `cwd` paths.
- [x] **Step 2: Start the bridge in a local process using the existing generated config, verify it remains alive, and inspect stderr/logs for discovery errors.
- [x] **Step 3: Re-run full tests, PowerShell tests, and syntax checks after the local-process test.
- [ ] **Step 4: Review `git diff`, stage only scoped files, commit with a Chinese message, push `main`, and verify `HEAD...origin/main` is `0 0`.

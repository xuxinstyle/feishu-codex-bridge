import { CodexAppServer } from "./codex-app-server.mjs";
import { validateModelName } from "./bridge-core.mjs";

// Ask the same engine that executes tasks: config/read resolves profiles,
// project layers and relative model_catalog_json paths for us.
export async function discoverCodexModels({ timeoutMs = 10_000, rpcFactory, ...options } = {}) {
  const rpc = rpcFactory ? rpcFactory(options) : new CodexAppServer({ ...options, requestTimeoutMs: timeoutMs });
  const timer = setTimeout(() => rpc.close(), timeoutMs);
  try {
    await rpc.initialize();
    const { config = {} } = await rpc.request("config/read", { cwd: options.cwd, includeLayers: false });
    const models = [];
    const seenModels = new Set();
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const result = await rpc.request("model/list", { limit: 100, cursor, includeHidden: false });
      if (!Array.isArray(result?.data)) throw new Error("Codex model/list returned an invalid catalog");
      for (const entry of result.data) {
        if (entry.hidden) continue;
        const model = entry.model;
        if (typeof model !== "string" || !validateModelName(model).ok || seenModels.has(model)) continue;
        seenModels.add(model);
        models.push(model);
      }
      cursor = result.nextCursor;
      if (!cursor) {
        if (!models.length) throw new Error("Codex model/list returned no selectable models");
        return { models, defaultModel: config.model || "", defaultReasoningEffort: config.model_reasoning_effort || "" };
      }
      if (seenCursors.has(cursor)) throw new Error("Codex model/list returned a repeated cursor");
      seenCursors.add(cursor);
    }
    throw new Error("Codex model/list returned too many pages");
  } finally {
    clearTimeout(timer);
    rpc.close();
  }
}

export function createModelCatalog({ discover = discoverCodexModels, configuredChoices = [], onError = () => {}, ...options } = {}) {
  const cache = new Map();
  const pending = new Map();
  return {
    get: cwd => cache.get(cwd),
    refresh(cwd) {
      if (pending.has(cwd)) return pending.get(cwd);
      const refresh = Promise.resolve().then(async () => {
        try {
          const result = await discover({ ...options, cwd });
          const extras = configuredChoices.filter(model => typeof model === "string" && validateModelName(model).ok);
          const entry = { ...result, models: [...new Set([...result.models, ...extras])], error: "" };
          cache.set(cwd, entry);
          return entry;
        } catch (error) {
          onError(error, cwd);
          const entry = { ...(cache.get(cwd) || {}), error: String(error) };
          cache.set(cwd, entry);
          return entry;
        } finally {
          pending.delete(cwd);
        }
      });
      pending.set(cwd, refresh);
      return refresh;
    },
  };
}

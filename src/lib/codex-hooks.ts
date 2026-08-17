import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

type HookEvent = "session_start" | "user_prompt_submit" | "subagent_start";

export interface CodexHook {
  id: string;
  origin: "plugin" | "local";
  plugin: string;
  event: HookEvent;
  command: string;
  timeout_ms: number;
  status_message?: string;
  source_path: string;
  plugin_root: string;
  trusted: boolean;
  supported: boolean;
  enabled: boolean;
  prompt_adapter_tool?: string;
}

interface HookOverride {
  enabled?: boolean;
  command?: string;
  timeout_ms?: number;
  status_message?: string;
  prompt_adapter_tool?: string;
  deleted?: boolean;
}

interface HookState {
  enabled?: string[];
  disabled?: string[];
  overrides?: Record<string, HookOverride>;
  custom?: Array<Partial<CodexHook>>;
}

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../profiles/codex-hooks.json");
const EVENT_MAP: Record<string, HookEvent | undefined> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
};

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function normalizedTimeout(value: unknown, fallback = 5000): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(1000, Math.round(number)), 15000) : fallback;
}

function text(value: unknown, fallback = "", max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function customHook(value: Partial<CodexHook>): CodexHook | undefined {
  const event = value.event;
  const command = text(value.command);
  if (!command || !event) return undefined;
  const id = /^local:[A-Za-z0-9_-]+$/.test(text(value.id, "", 120)) ? value.id! : `local:${crypto.randomUUID()}`;
  return {
    id,
    origin: "local",
    plugin: text(value.plugin, "Local Coder", 120) || "Local Coder",
    event,
    command,
    timeout_ms: normalizedTimeout(value.timeout_ms),
    status_message: text(value.status_message, "", 500) || undefined,
    source_path: STATE_PATH,
    plugin_root: "",
    trusted: true,
    supported: event === "session_start",
    enabled: value.enabled === true,
    prompt_adapter_tool: text(value.prompt_adapter_tool, "", 120) || undefined,
  };
}

async function codexConfig(): Promise<{ enabledPlugins: Set<string>; trustedHooks: Set<string> }> {
  let text = "";
  try {
    text = await fs.readFile(path.join(CODEX_HOME, "config.toml"), "utf-8");
  } catch {
    return { enabledPlugins: new Set(), trustedHooks: new Set() };
  }
  const enabledPlugins = new Set<string>();
  for (const match of text.matchAll(/\[plugins\."([^"]+)"\]([\s\S]*?)(?=\r?\n\[|$)/g)) {
    if (/^enabled\s*=\s*true\s*$/m.test(match[2])) enabledPlugins.add(match[1]);
  }
  const trustedHooks = new Set(
    [...text.matchAll(/\[hooks\.state\."([^"]+)"\]/g)].map((match) => match[1])
  );
  return { enabledPlugins, trustedHooks };
}

async function latestPluginRoot(plugin: string): Promise<string | undefined> {
  const at = plugin.lastIndexOf("@");
  if (at <= 0) return undefined;
  const packageName = plugin.slice(0, at);
  const source = plugin.slice(at + 1);
  const base = path.join(CODEX_HOME, "plugins", "cache", source, packageName);
  try {
    const versions = (await fs.readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return versions.length ? path.join(base, versions[0]) : undefined;
  } catch {
    return undefined;
  }
}

export async function getCodexHooks(): Promise<CodexHook[]> {
  const { enabledPlugins, trustedHooks } = await codexConfig();
  const state = await readJson<HookState>(STATE_PATH, {});
  const forcedEnabled = new Set(state.enabled ?? []);
  const forcedDisabled = new Set(state.disabled ?? []);
  const found: CodexHook[] = [];

  for (const plugin of enabledPlugins) {
    const pluginRoot = await latestPluginRoot(plugin);
    if (!pluginRoot) continue;
    const hooksDir = path.join(pluginRoot, "hooks");
    let manifests: string[] = [];
    try {
      manifests = (await fs.readdir(hooksDir))
        .filter((file) => file.endsWith(".json") && file.toLowerCase().includes("codex"));
    } catch {
      continue;
    }
    for (const manifestFile of manifests) {
      const sourcePath = path.join(hooksDir, manifestFile);
      const manifest = await readJson<{ hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number; statusMessage?: string }> }> > }>(sourcePath, {});
      for (const [eventName, groups] of Object.entries(manifest.hooks ?? {})) {
        const event = EVENT_MAP[eventName];
        if (!event) continue;
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
          for (let hookIndex = 0; hookIndex < (groups[groupIndex].hooks?.length ?? 0); hookIndex += 1) {
            const hook = groups[groupIndex].hooks![hookIndex];
            if (hook.type !== "command" || !hook.command) continue;
            const id = `${plugin}:hooks/${manifestFile}:${event}:${groupIndex}:${hookIndex}`;
            const trusted = trustedHooks.has(id);
            found.push({
              id,
              origin: "plugin",
              plugin,
              event,
              command: hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
              timeout_ms: Math.min(Math.max(1000, (hook.timeout ?? 5) * 1000), 15000),
              status_message: hook.statusMessage,
              source_path: sourcePath,
              plugin_root: pluginRoot,
              trusted,
              supported: event === "session_start",
              enabled: !forcedDisabled.has(id) && (forcedEnabled.has(id) || trusted),
            });
          }
        }
      }
    }
  }
  const configured = found
    .filter((hook) => !state.overrides?.[hook.id]?.deleted)
    .map((hook) => {
      const override = state.overrides?.[hook.id];
      return {
        ...hook,
        command: text(override?.command, hook.command),
        timeout_ms: normalizedTimeout(override?.timeout_ms, hook.timeout_ms),
        status_message: text(override?.status_message, hook.status_message ?? "", 500) || undefined,
        enabled: override?.enabled ?? hook.enabled,
        prompt_adapter_tool: text(override?.prompt_adapter_tool, "", 120) || undefined,
      };
    });
  return [...configured, ...(state.custom ?? []).flatMap((hook) => {
    const normalized = customHook(hook);
    return normalized ? [normalized] : [];
  })];
}

export async function saveCodexHooks(input: unknown): Promise<CodexHook[]> {
  const payload = input && typeof input === "object" ? input as { hooks?: unknown; deleted_ids?: unknown } : {};
  const submitted = Array.isArray(payload.hooks)
    ? payload.hooks.filter((hook): hook is Partial<CodexHook> => Boolean(hook) && typeof hook === "object")
    : [];
  const deleted = new Set(Array.isArray(payload.deleted_ids) ? payload.deleted_ids.filter((id): id is string => typeof id === "string") : []);
  const hooks = await getCodexHooks();
  const existingPlugins = new Map(hooks.filter((hook) => hook.origin === "plugin").map((hook) => [hook.id, hook]));
  const overrides: Record<string, HookOverride> = {};
  const custom: CodexHook[] = [];
  for (const hook of submitted) {
    const id = text(hook.id, "", 200);
    if (deleted.has(id)) continue;
    const original = existingPlugins.get(id);
    if (original) {
      overrides[id] = {
        enabled: hook.enabled === true,
        command: text(hook.command, original.command),
        timeout_ms: normalizedTimeout(hook.timeout_ms, original.timeout_ms),
        status_message: text(hook.status_message, "", 500) || undefined,
        prompt_adapter_tool: text(hook.prompt_adapter_tool, "", 120) || undefined,
      };
      continue;
    }
    const local = customHook(hook);
    if (local) custom.push(local);
  }
  for (const id of deleted) {
    if (existingPlugins.has(id)) overrides[id] = { deleted: true };
  }
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify({ overrides, custom }, null, 2) + "\n");
  return getCodexHooks();
}

function execute(command: string, timeoutMs: number, input?: string): Promise<string> {
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      windowsHide: true,
      env: { ...process.env, PLUGIN_DATA: CODEX_HOME },
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.stdin.end(input);
  });
}

function hookContext(output: string): string {
  try {
    const parsed = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: unknown } };
    return typeof parsed.hookSpecificOutput?.additionalContext === "string"
      ? parsed.hookSpecificOutput.additionalContext
      : "";
  } catch {
    return output;
  }
}

export async function runCodexSessionStartHooks(): Promise<string> {
  const allHooks = await getCodexHooks();
  const hooks = allHooks.filter((hook) => hook.enabled && hook.supported);
  const output = await Promise.all(hooks.map(async (hook) => hookContext(await execute(hook.command, hook.timeout_ms))));
  const adapters = allHooks.filter((hook) => hook.enabled && hook.event === "user_prompt_submit" && /^[A-Za-z0-9_.-]+$/.test(hook.prompt_adapter_tool ?? ""));
  if (adapters.length) {
    output.push(adapters.map((hook) => `Prompt adapter enabled for ${hook.id}. Before responding to each user message, call ${hook.prompt_adapter_tool} with the exact current user prompt. Apply only the instructions or state returned by that tool.`).join("\n"));
  }
  return output.filter(Boolean).join("\n\n").slice(0, 120_000);
}

export async function runCodexHook(hook: Pick<CodexHook, "command" | "timeout_ms">, input?: string): Promise<string> {
  return hookContext(await execute(hook.command, hook.timeout_ms, input));
}

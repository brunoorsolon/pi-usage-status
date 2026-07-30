/**
 * Pi extension: footer quota bars for openai-codex (subscription) and
 * kimi-coding (OAuth). Unlike pi-usage-bars, auth resolution also reads
 * `auth.headers`, because kimi-coding OAuth resolves to a headers-only
 * Bearer token.
 *
 * Status key is "usage-bars" so pi-powerline-footer customItems can use it.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "usage-bars";
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

interface WindowUsage {
  percent: number;
  resetsAtMs?: number;
}

interface ProviderUsage {
  session: WindowUsage;
  sessionLabel: "5h" | "W";
  weekly?: WindowUsage;
}

// --- pure helpers, unit-tested by test.mjs ---

export function bearerToken(auth: { apiKey?: string; headers?: Record<string, string | null> } | undefined): string | undefined {
  if (auth?.apiKey) return auth.apiKey;
  const header = auth?.headers?.Authorization ?? auth?.headers?.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function parseCodexUsage(data: any, nowMs: number): ProviderUsage {
  const primary = data?.rate_limit?.primary_window;
  const secondary = data?.rate_limit?.secondary_window;
  const toWindow = (win: any): WindowUsage => ({
    percent: typeof win?.used_percent === "number" ? win.used_percent : 0,
    resetsAtMs: typeof win?.reset_after_seconds === "number" ? nowMs + win.reset_after_seconds * 1000 : undefined,
  });
  // Pro Lite exposes its weekly window as the only primary window.
  if (!secondary && Number(primary?.limit_window_seconds) === WEEK_SECONDS) {
    return { session: toWindow(primary), sessionLabel: "W" };
  }
  return {
    session: toWindow(primary),
    sessionLabel: "5h",
    weekly: secondary ? toWindow(secondary) : undefined,
  };
}

export function parseKimiUsage(data: any, nowMs: number): ProviderUsage {
  void nowMs;
  const toWindow = (detail: any): WindowUsage | undefined => {
    const limit = Number(detail?.limit);
    const used = Number(detail?.used);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return undefined;
    const resetMs = Date.parse(detail?.resetTime ?? "");
    return { percent: (used / limit) * 100, resetsAtMs: Number.isFinite(resetMs) ? resetMs : undefined };
  };
  // limits[0] is the short (5-hour) window; `usage` is the overall quota.
  const session = toWindow(data?.limits?.[0]?.detail);
  const weekly = toWindow(data?.usage);
  if (!session && !weekly) throw new Error("unrecognized response shape");
  return {
    session: session ?? weekly!,
    sessionLabel: "5h",
    weekly: session ? weekly : undefined,
  };
}

// --- fetching ---

async function fetchJson(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// --- rendering ---

function renderBar(percent: number): string {
  const cells = 8;
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

function renderReset(resetsAtMs: number | undefined, nowMs: number): string {
  if (resetsAtMs === undefined) return "";
  const minutes = Math.max(0, Math.round((resetsAtMs - nowMs) / 60_000));
  const text = minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (24 * 60))}d`;
  return ` ⟳ ${text}`;
}

function render(theme: Theme, label: string, usage: ProviderUsage): string {
  const nowMs = Date.now();
  const windowText = (win: WindowUsage) =>
    theme.fg("muted", `${renderBar(win.percent)} ${Math.round(win.percent)}%`) +
    theme.fg("dim", renderReset(win.resetsAtMs, nowMs));
  let text = theme.fg("dim", `${label} `) + theme.fg("muted", `${usage.sessionLabel} `) + windowText(usage.session);
  if (usage.weekly) text += theme.fg("dim", " · W ") + windowText(usage.weekly);
  return text;
}

// --- extension ---

const LABELS: Record<string, string> = {
  "openai-codex": "Codex",
  "kimi-coding": "Kimi",
};

export default function usageStatus(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;

  async function poll(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    const provider = ctx.model?.provider;
    const label = provider ? LABELS[provider] : undefined;
    const gen = ++generation;
    if (!provider || !label) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const theme = ctx.ui.theme;
    try {
      if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const resolved = await ctx.modelRegistry.getProviderAuth(provider);
      const token = bearerToken(resolved?.auth);
      if (!token) throw new Error("configured authentication did not resolve a token");
      const data =
        provider === "openai-codex"
          ? await fetchJson(CODEX_USAGE_URL, token)
          : await fetchJson(KIMI_USAGE_URL, token, { "User-Agent": "KimiCLI/1.5" });
      const usage = provider === "openai-codex" ? parseCodexUsage(data, Date.now()) : parseKimiUsage(data, Date.now());
      if (gen !== generation) return;
      ctx.ui.setStatus(STATUS_KEY, render(theme, label, usage));
    } catch (error) {
      if (gen !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `${label} usage unavailable (${message})`));
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ctx.mode === "tui") timer = setInterval(() => void poll(ctx), POLL_INTERVAL_MS);
    void poll(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    void poll(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

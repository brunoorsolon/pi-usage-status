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
  sessionLabel: "5h" | "7d";
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
    return { session: toWindow(primary), sessionLabel: "7d" };
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
  const durationMinutes = (window: any): number | undefined => {
    const duration = Number(window?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return undefined;
    switch (window?.timeUnit) {
      case "TIME_UNIT_MINUTE": return duration;
      case "TIME_UNIT_HOUR": return duration * 60;
      case "TIME_UNIT_DAY": return duration * 24 * 60;
      default: return undefined;
    }
  };
  // The API returns the rolling windows in no guaranteed order. `usage` is the
  // account-wide quota, not the seven-day Code quota shown in the footer.
  const limits = (data?.limits ?? [])
    .map((limit: any) => ({ usage: toWindow(limit?.detail), minutes: durationMinutes(limit?.window) }))
    .filter((limit: { usage: WindowUsage | undefined }) => limit.usage);
  const session = limits.find((limit: { minutes?: number }) => limit.minutes === 5 * 60)?.usage
    ?? limits.sort((a: { minutes?: number }, b: { minutes?: number }) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity))[0]?.usage;
  const weekly = limits.find((limit: { minutes?: number }) => limit.minutes === 7 * 24 * 60)?.usage;
  if (!session) throw new Error("unrecognized response shape");
  return { session, sessionLabel: "5h", weekly };
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

export function usageColor(percent: number): "success" | "warning" | "error" {
  if (percent <= 50) return "success";
  if (percent <= 75) return "warning";
  return "error";
}

function renderReset(resetsAtMs: number | undefined, nowMs: number): string {
  if (resetsAtMs === undefined) return "";
  const minutes = Math.max(0, Math.round((resetsAtMs - nowMs) / 60_000));
  const text = minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (24 * 60))}d`;
  return ` ↻ ${text}`;
}

function render(theme: Theme, usage: ProviderUsage): string {
  const nowMs = Date.now();
  const windowText = (label: string, win: WindowUsage) =>
    theme.fg("muted", `${label}: `) + theme.fg(usageColor(win.percent), `${Math.round(win.percent)}%`) +
    theme.fg("dim", renderReset(win.resetsAtMs, nowMs));
  let text = windowText(usage.sessionLabel, usage.session);
  if (usage.weekly) text += theme.fg("dim", " | ") + windowText("7d", usage.weekly);
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
      ctx.ui.setStatus(STATUS_KEY, render(theme, usage));
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

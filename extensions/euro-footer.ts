/**
 * Euro Footer Extension
 *
 * Replaces pi's default footer with a faithful copy that presents the
 * running session cost in EUROS instead of US dollars.
 *
 * - USD→EUR rate is fetched once per day from the ECB-backed Frankfurter API
 *   (https://api.frankfurter.app, free, no key). Cached to
 *   ~/.pi/agent/euro-rate.json. The latest cached rate is used as the
 *   fallback when offline; a placeholder is shown only if no rate is known.
 * - Everything else mirrors pi's built-in footer: pwd + git branch + session
 *   name, token stats (↑↓, R/W cache, CH%), context %/window, auto-compact
 *   indicator, model + provider + thinking level, and other extensions'
 *   status lines.
 *
 * Auto-discovered: place at ~/.pi/agent/extensions/euro-footer.ts and run
 * `/reload` (or restart pi). Remove the file + `/reload` to restore defaults.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	const RATE_TTL_MS = 24 * 60 * 60 * 1000; // refresh once per day
	const API_URL = "https://api.frankfurter.app/latest?from=USD&to=EUR";

	const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const cacheFile = join(configDir, "euro-rate.json");

	// Known rate (cache or freshly fetched). NaN until the first one is loaded.
	let rate: number = NaN;
	let rateDate: string | undefined;
	let fetchInFlight = false;

	/** Synchronously load the latest cached rate so even the first render uses it. */
	function loadCachedRateSync(): void {
		try {
			if (!existsSync(cacheFile)) return;
			const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
			if (typeof parsed?.rate === "number" && parsed.rate > 0) {
				rate = parsed.rate;
				rateDate = parsed.date;
			}
		} catch {
			// ignore corrupt cache
		}
	}

	async function refreshRate(): Promise<void> {
		if (fetchInFlight) return;

		// Decide freshness from the cached file's timestamp.
		let cachedAge = Infinity;
		try {
			if (existsSync(cacheFile)) {
				const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
				cachedAge = parsed.fetchedAt ? Date.now() - parsed.fetchedAt : Infinity;
			}
		} catch {
			// ignore
		}
		if (cachedAge < RATE_TTL_MS) return; // cache still fresh

		fetchInFlight = true;
		try {
			const res = await fetch(API_URL, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { rates?: { EUR?: number }; date?: string };
			const eur = json?.rates?.EUR;
			if (typeof eur === "number" && eur > 0) {
				rate = eur;
				rateDate = json?.date;
				await mkdir(dirname(cacheFile), { recursive: true }).catch(() => {});
				await writeFile(
					cacheFile,
					JSON.stringify({ rate, date: rateDate, fetchedAt: Date.now() }, null, 2),
				).catch(() => {});
			}
		} catch {
			// offline or API down: keep the last-known cached rate
		} finally {
			fetchInFlight = false;
		}
	}

	// Replicate pi's built-in footer token formatter (k/M compaction).
	function formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
	}

	function formatCwd(cwd: string, home: string | undefined): string {
		if (!home) return cwd;
		const sep = process.platform === "win32" ? "\\" : "/";
		const normalize = (p: string) =>
			p.replace(/[\\/]+/g, sep).replace(new RegExp(`${sep}$`), "");
		const h = normalize(home);
		const c = normalize(cwd);
		if (c === h) return "~";
		if (c.startsWith(h + sep)) return "~" + c.slice(h.length);
		return cwd;
	}

	function sanitizeStatusText(text: string): string {
		return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
	}

	// Best-effort detection of auto-compaction from settings files (project
	// overrides global). Returns true unless explicitly disabled.
	function autoCompactionEnabled(cwd: string): boolean {
		const read = (file: string): boolean | undefined => {
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8"));
				if (parsed?.compaction && typeof parsed.compaction === "object") {
					const en = parsed.compaction.enabled;
					if (typeof en === "boolean") return en;
				}
			} catch {
				// ignore
			}
			return undefined;
		};
		const project = read(join(cwd, ".pi", "settings.json"));
		if (project !== undefined) return project;
		const globalS = read(join(configDir, "settings.json"));
		if (globalS !== undefined) return globalS;
		return true; // pi's default
	}

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;

		loadCachedRateSync();
		void refreshRate().then(() => {
			// first fetch completed; nudge a re-render so the placeholder clears
			try {
				ctx.ui.setFooter((tui) => {
					tui.requestRender();
					return { invalidate() {}, render: () => [] };
				});
			} catch {
				// ignore; the real setFooter below rebinds and re-renders
			}
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			void refreshRate().then(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ---- Token totals from session branch ----
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCostUsd = 0;
					let latestCacheHitRate: number | undefined;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCostUsd += m.usage.cost.total;
							const prompt = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
							latestCacheHitRate =
								prompt > 0 ? (m.usage.cacheRead / prompt) * 100 : latestCacheHitRate;
						}
					}

					// ---- Cost in euros (latest known rate; placeholder if unknown) ----
					const known = Number.isFinite(rate) && rate > 0;
					const euroCost = known ? totalCostUsd * rate : NaN;

					// ---- pwd line ----
					let pwd = formatCwd(ctx.cwd, homedir());
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// ---- stats: left side ----
					const parts: string[] = [];
					if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);
					if (
						(totalCacheRead > 0 || totalCacheWrite > 0) &&
						latestCacheHitRate !== undefined
					) {
						parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					// Cost in euros, rounded to 2 decimals (the whole point of this extension).
					parts.push(known ? `€${euroCost.toFixed(2)}` : `€—`);

					// ---- context % ----
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const pct = usage?.percent ?? null;
					const auto = autoCompactionEnabled(ctx.cwd) ? " (auto)" : "";
					const ctxDisplay =
						pct === null
							? `?/${formatTokens(contextWindow)}${auto}`
							: `${pct.toFixed(1)}%/${formatTokens(contextWindow)}${auto}`;

					// ---- compose left with per-piece coloring ----
					const dimParts = parts.map((p) => theme.fg("dim", p)).join(" ");
					let ctxPart: string;
					if (pct !== null && pct > 90) ctxPart = theme.fg("error", ctxDisplay);
					else if (pct !== null && pct > 70) ctxPart = theme.fg("warning", ctxDisplay);
					else ctxPart = theme.fg("dim", ctxDisplay);
					const statsLeft = `${dimParts} ${ctxPart}`;

					// ---- right side: provider + model + thinking ----
					let right = ctx.model?.id || "no-model";
					if (ctx.model?.reasoning) {
						let lvl = "off";
						try {
							lvl = pi.getThinkingLevel() || "off";
						} catch {
							// fall through
						}
						right = lvl === "off" ? `${right} • thinking off` : `${right} • ${lvl}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						right = `(${ctx.model.provider}) ${right}`;
					}

					// ---- pack into the line ----
					const leftW = visibleWidth(statsLeft);
					const rightW = visibleWidth(right);
					let statsLine: string;
					if (leftW + 2 + rightW <= width) {
						statsLine = statsLeft + " ".repeat(width - leftW - rightW) + right;
					} else {
						const avail = width - leftW - 2;
						if (avail > 0) {
							const tr = truncateToWidth(right, avail, "");
							statsLine =
								statsLeft + " ".repeat(Math.max(0, width - leftW - visibleWidth(tr))) + tr;
						} else {
							statsLine = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));
						}
					}
					const dimStatsLine = theme.fg("dim", statsLine);

					const pwdLine = truncateToWidth(
						theme.fg("dim", pwd),
						width,
						theme.fg("dim", "..."),
					);

					const lines = [pwdLine, dimStatsLine];

					// ---- other extensions' status lines (good citizen) ----
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const sorted = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => sanitizeStatusText(t))
							.join(" ");
						lines.push(truncateToWidth(sorted, width, theme.fg("dim", "...")));
					}

					return lines.map((l) => truncateToWidth(l, width, ""));
				},
			};
		});
	});
}
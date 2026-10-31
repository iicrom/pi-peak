/**
 * /peak — peak / off-peak hour awareness for models.
 *
 * Configure the hours when a model charges its peak rate (for example DeepSeek's
 * UTC 01:00-04:00 and 06:00-10:00). Whenever that model is the active model, the
 * status bar shows whether you are in peak hours and how long until the next change.
 *
 * Config lives in `~/.pi/agent/peak-hours.json` so it applies to all sessions.
 *
 * Commands:
 *   /peak                                  select a model, then pick a preset or custom windows
 *   /peak status                           current model's peak state, in detail
 *   /peak list                             every configured model and its state right now
 *   /peak set [utc|local] [days] <windows> set windows for the current model
 *   /peak preset <name>                    apply a preset to the current model
 *   /peak clear                            remove the current model's windows
 *   /peak help                             usage
 *
 * Usage: pi -e ./pi-peak
 */

import { statSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";
import {
	allPresets,
	configPath,
	describeModelConfig,
	emptyConfig,
	loadConfig,
	lookupConfig,
	modelKey,
	type ModelPeakConfig,
	type PeakConfigFile,
	saveConfig,
	setModelConfig,
} from "../src/config.ts";
import { describeState, renderStatusLine, STATUS_KEY } from "../src/status.ts";
import { inputWindowSpec, pickWithList } from "../src/ui.ts";
import {
	evaluatePeak,
	formatSpec,
	formatWindowList,
	frameLabel,
	parseWindowSpec,
	type PeakWindow,
	type TimeFrame,
} from "../src/windows.ts";

/** The status line only changes once a minute, so a coarse tick is enough. */
const REFRESH_INTERVAL_MS = 20_000;

type ChatModel = NonNullable<ExtensionContext["model"]>;

/** pi exposes an `unknown/unknown` placeholder when no model is configured. */
function isPlaceholderModel(model: ChatModel | undefined): boolean {
	return !model || (model.provider === "unknown" && model.id === "unknown");
}

/** `provider/model` for the active model, or undefined for the placeholder. */
function activeModelKey(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	return model && !isPlaceholderModel(model) ? modelKey(model.provider, model.id) : undefined;
}

interface PeakAction {
	kind: "preset" | "custom" | "remove";
	preset?: string;
}

export default function peakExtension(pi: ExtensionAPI) {
	let config: PeakConfigFile = emptyConfig();
	let configFilePath = configPath();
	let configStamp: string | undefined;
	let lastStatus: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	/** Cheap fingerprint so hand edits to the JSON file are picked up mid-session. */
	function fileStamp(path: string): string | undefined {
		try {
			const stat = statSync(path);
			return `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
	}

	function reload(): string[] {
		const loaded = loadConfig();
		config = loaded.config;
		configFilePath = loaded.path;
		configStamp = fileStamp(configFilePath);
		return loaded.warnings;
	}

	function persist(ctx: ExtensionContext): boolean {
		try {
			saveConfig(config, configFilePath);
			configStamp = fileStamp(configFilePath);
			return true;
		} catch (error) {
			ctx.ui.notify(`pi-peak: could not write ${configFilePath}: ${(error as Error).message}`, "error");
			reload();
			return false;
		}
	}

	/** Recompute and publish the status line for the active model. */
	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			lastStatus = undefined;
			return;
		}

		const model = ctx.model;
		const found = model && !isPlaceholderModel(model) ? lookupConfig(config, model.provider, model.id) : undefined;
		const line = found
			? renderStatusLine(
					found.entry,
					evaluatePeak(found.entry.windows, new Date(), found.entry.frame),
					ctx.ui.theme,
				)
			: undefined;

		if (line === lastStatus) return;
		ctx.ui.setStatus(STATUS_KEY, line);
		lastStatus = line;
	}

	// ---------------------------------------------------------------------
	// Model list helpers
	// ---------------------------------------------------------------------

	/** Models to offer: registry models plus configured keys that no longer resolve. */
	function collectModels(ctx: ExtensionContext): Array<{ key: string; model?: ChatModel }> {
		const currentKey = activeModelKey(ctx);

		const registry = ctx.modelRegistry.getAvailable();
		const models = registry.length > 0 ? registry : ctx.modelRegistry.getAll();

		const seen = new Set<string>();
		const entries: Array<{ key: string; model?: ChatModel }> = [];
		for (const model of models) {
			const key = modelKey(model.provider, model.id);
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ key, model });
		}

		// Keep stale configs reachable so they can be edited or removed.
		for (const key of Object.keys(config.models)) {
			if (key.includes("*") || seen.has(key)) continue;
			entries.push({ key });
		}

		entries.sort((a, b) => {
			const aConfigured = config.models[a.key] ? 0 : 1;
			const bConfigured = config.models[b.key] ? 0 : 1;
			if (aConfigured !== bConfigured) return aConfigured - bConfigured;
			const aCurrent = a.key === currentKey ? 0 : 1;
			const bCurrent = b.key === currentKey ? 0 : 1;
			if (aCurrent !== bCurrent) return aCurrent - bCurrent;
			return a.key.localeCompare(b.key);
		});

		return entries;
	}

	function modelItems(ctx: ExtensionContext): SelectItem[] {
		const currentKey = activeModelKey(ctx);

		return collectModels(ctx).map(({ key, model }) => {
			const entry = config.models[key];
			const now = entry ? evaluatePeak(entry.windows, new Date(), entry.frame) : undefined;
			const parts: string[] = [];
			if (now) parts.push(now.peak ? "in peak" : "off-peak");
			if (entry) parts.push(describeModelConfig(entry));
			else parts.push(model?.name ?? "not in registry");

			const marker = key === currentKey ? "● " : entry ? "✓ " : "  ";
			return { value: key, label: `${marker}${key}`, description: parts.join(" · ") };
		});
	}

	function requireModel(ctx: ExtensionCommandContext): ChatModel | undefined {
		const model = ctx.model;
		if (isPlaceholderModel(model)) {
			ctx.ui.notify("pi-peak: no model selected. Configure a provider and pick a model with /model first.", "warning");
			return undefined;
		}
		return model;
	}

	// ---------------------------------------------------------------------
	// Mutations
	// ---------------------------------------------------------------------

	function writeModelConfig(
		ctx: ExtensionContext,
		key: string,
		next: Omit<ModelPeakConfig, "updatedAt"> | undefined,
	): boolean {
		setModelConfig(config, key, next);
		if (!persist(ctx)) return false;
		updateStatus(ctx);
		return true;
	}

	function announce(ctx: ExtensionContext, key: string, entry: ModelPeakConfig): void {
		ctx.ui.notify(
			`pi-peak: ${key} → ${frameLabel(entry.frame)} ${formatWindowList(entry.windows)}`,
			"info",
		);
	}

	function applyPreset(ctx: ExtensionCommandContext, key: string, presetName: string): boolean {
		const preset = allPresets(config)[presetName];
		if (!preset) {
			const available = Object.keys(allPresets(config)).sort().join(", ") || "(none)";
			ctx.ui.notify(`pi-peak: unknown preset "${presetName}". Available: ${available}`, "error");
			return false;
		}
		const entry: Omit<ModelPeakConfig, "updatedAt"> = {
			frame: preset.frame,
			windows: preset.windows.map((window) => ({
				...window,
				...(window.days === undefined ? {} : { days: [...window.days] }),
			})),
			preset: presetName,
		};
		if (!writeModelConfig(ctx, key, entry)) return false;
		announce(ctx, key, { ...entry });
		return true;
	}

	function applyWindows(
		ctx: ExtensionCommandContext,
		key: string,
		frame: TimeFrame,
		windows: PeakWindow[],
	): boolean {
		const entry: Omit<ModelPeakConfig, "updatedAt"> = { frame, windows };
		if (!writeModelConfig(ctx, key, entry)) return false;
		announce(ctx, key, { ...entry });
		return true;
	}

	/** Parse and apply a `/peak set` spec against one model key. */
	function applySpec(ctx: ExtensionCommandContext, key: string, spec: string, fallbackFrame?: TimeFrame): boolean {
		const parsed = parseWindowSpec(spec);
		if (parsed.error) {
			ctx.ui.notify(`pi-peak: ${parsed.error}`, "error");
			return false;
		}
		return applyWindows(ctx, key, parsed.frame ?? fallbackFrame ?? "utc", parsed.windows);
	}

	// ---------------------------------------------------------------------
	// /peak flows
	// ---------------------------------------------------------------------

	async function interactive(ctx: ExtensionCommandContext): Promise<void> {
		const current = requireModel(ctx);
		if (!current) return;

		const items = modelItems(ctx);
		if (items.length === 0) {
			ctx.ui.notify("pi-peak: no models available. Configure a provider with /login first.", "warning");
			return;
		}

		const currentKey = activeModelKey(ctx);
		const chosenKey = await pickWithList(ctx, "Peak hours · model", items, {
			preselect: currentKey,
			subtitle: "Pick the model to configure",
		});
		if (!chosenKey) return;

		const action = await pickAction(ctx, chosenKey);
		if (!action) return;

		if (action.kind === "preset" && action.preset) {
			applyPreset(ctx, chosenKey, action.preset);
			return;
		}

		if (action.kind === "remove") {
			const had = Boolean(config.models[chosenKey]);
			if (!had || writeModelConfig(ctx, chosenKey, undefined)) {
				ctx.ui.notify(`pi-peak: cleared peak hours for ${chosenKey}`, "info");
			}
			return;
		}

		await promptCustomWindows(ctx, chosenKey);
	}

	async function pickAction(ctx: ExtensionCommandContext, key: string): Promise<PeakAction | undefined> {
		const presets = allPresets(config);
		const items: SelectItem[] = Object.entries(presets)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, preset]) => ({
				value: `preset:${name}`,
				label: `preset: ${name}`,
				description: `${frameLabel(preset.frame)} ${formatWindowList(preset.windows)}${
					preset.description ? ` · ${preset.description}` : ""
				}`,
			}));

		items.push({
			value: "custom",
			label: "custom windows…",
			description: "Type times, e.g. utc 01:00-04:00 06:00-10:00",
		});

		const existing = config.models[key];
		if (existing) {
			items.push({
				value: "remove",
				label: "remove",
				description: `Currently: ${describeModelConfig(existing)}`,
			});
		}

		const chosen = await pickWithList(ctx, `Peak hours · ${key}`, items, {
			preselect: existing?.preset ? `preset:${existing.preset}` : undefined,
			subtitle: existing ? `Current: ${describeModelConfig(existing)}` : "No peak hours configured yet",
		});
		if (!chosen) return undefined;
		if (chosen === "custom") return { kind: "custom" };
		if (chosen === "remove") return { kind: "remove" };
		return { kind: "preset", preset: chosen.slice("preset:".length) };
	}

	async function promptCustomWindows(ctx: ExtensionCommandContext, key: string): Promise<void> {
		const existing = config.models[key];
		const placeholder = existing
			? formatSpec(existing.frame, existing.windows)
			: "utc 01:00-04:00 06:00-10:00";

		for (let attempt = 0; attempt < 3; attempt++) {
			const spec = await inputWindowSpec(ctx, `Peak windows for ${key}`, placeholder);
			if (!spec) return;

			const parsed = parseWindowSpec(spec);
			if (parsed.error) {
				ctx.ui.notify(`pi-peak: ${parsed.error}`, "error");
				continue;
			}
			applyWindows(ctx, key, parsed.frame ?? existing?.frame ?? "utc", parsed.windows);
			return;
		}
	}

	function showStatus(ctx: ExtensionCommandContext, rawSpec: string): void {
		const model = requireModel(ctx);
		if (!model) return;

		const found = lookupConfig(config, model.provider, model.id);
		if (!found) {
			ctx.ui.notify(
				`pi-peak: no peak hours configured for ${modelKey(model.provider, model.id)}. Run /peak to set them.`,
				"info",
			);
			return;
		}

		// `/peak status utc 01:00-04:00 …` previews a spec without saving it.
		if (rawSpec) {
			const parsed = parseWindowSpec(rawSpec);
			if (parsed.error) {
				ctx.ui.notify(`pi-peak: ${parsed.error}`, "error");
				return;
			}
			const preview: ModelPeakConfig = {
				frame: parsed.frame ?? found.entry.frame,
				windows: parsed.windows,
			};
			ctx.ui.notify(describeState("preview", preview, new Date()), "info");
			return;
		}

		ctx.ui.notify(describeState(found.key, found.entry, new Date()), "info");
	}

	function showList(ctx: ExtensionCommandContext): void {
		const keys = Object.keys(config.models).sort();
		if (keys.length === 0) {
			ctx.ui.notify(`pi-peak: nothing configured yet. Run /peak (file: ${configFilePath}).`, "info");
			return;
		}

		const now = new Date();
		const currentKey = activeModelKey(ctx);

		const lines = keys.map((key) => {
			const entry = config.models[key];
			if (!entry) return undefined;
			const state = evaluatePeak(entry.windows, now, entry.frame);
			const marker = key === currentKey ? "●" : " ";
			const active = state.peak ? "PEAK now" : "off-peak now";
			return `${marker} ${key} · ${describeModelConfig(entry)} · ${active}`;
		});

		const body = lines.filter((line): line is string => line !== undefined);
		ctx.ui.notify([`Peak hours (${configFilePath})`, ...body].join("\n"), "info");
	}

	function showHelp(ctx: ExtensionCommandContext): void {
		ctx.ui.notify(
			[
				"/peak — pick a model, then a preset or custom windows",
				"/peak status — current model's peak state, in detail",
				"/peak list — configured models and their state now",
				"/peak set [utc|local] [days] <windows> — e.g. /peak set utc mon-fri 01:00-04:00 06:00-10:00",
				"/peak preset <name> — apply a preset to the current model",
				"/peak clear — remove the current model's windows",
				`Presets: ${Object.keys(allPresets(config)).sort().join(", ")}`,
				`Config: ${configFilePath}`,
				"Windows are half-open; 22:00-02:00 wraps midnight; 00:00-24:00 means all day.",
				"Days: mon-fri, weekdays, weekends, or a list like mon,wed,fri.",
			].join("\n"),
			"info",
		);
	}

	// ---------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------

	pi.registerCommand("peak", {
		description: "Configure peak hours for a model (shown in the status bar when active)",
		getArgumentCompletions: (prefix) => {
			const items: AutocompleteItem[] = [
				{ value: "status", label: "status", description: "Show the current model's peak state" },
				{ value: "list", label: "list", description: "List configured models" },
				{ value: "set", label: "set", description: "Set windows for the current model" },
				{ value: "preset", label: "preset", description: "Apply a preset to the current model" },
				{ value: "clear", label: "clear", description: "Remove the current model's windows" },
				{ value: "help", label: "help", description: "Usage" },
				...Object.entries(allPresets(config)).map(([name, preset]) => ({
					value: name,
					label: name,
					description: `${frameLabel(preset.frame)} ${formatWindowList(preset.windows)}`,
				})),
			];
			const needle = prefix.trim();
			const filtered = items.filter((item) => item.value.startsWith(needle));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const sub = trimmed.split(/\s+/)[0] ?? "";
			const rest = trimmed.slice(sub.length).trim();

			switch (sub) {
				case "":
					await interactive(ctx);
					return;
				case "status":
					showStatus(ctx, rest);
					return;
				case "list":
					showList(ctx);
					return;
				case "set": {
					const model = requireModel(ctx);
					if (!model) return;
					const key = modelKey(model.provider, model.id);
					const existing = config.models[key];
					if (!rest) {
						await promptCustomWindows(ctx, key);
						return;
					}
					if (allPresets(config)[rest]) {
						applyPreset(ctx, key, rest);
						return;
					}
					applySpec(ctx, key, rest, existing?.frame);
					return;
				}
				case "preset": {
					const model = requireModel(ctx);
					if (!model) return;
					const key = modelKey(model.provider, model.id);
					if (!rest) {
						const action = await pickAction(ctx, key);
						if (action?.kind === "preset" && action.preset) applyPreset(ctx, key, action.preset);
						else if (action?.kind === "custom") await promptCustomWindows(ctx, key);
						return;
					}
					applyPreset(ctx, key, rest);
					return;
				}
				case "clear":
				case "remove":
				case "off": {
					const model = requireModel(ctx);
					if (!model) return;
					const key = modelKey(model.provider, model.id);
					if (!config.models[key]) {
						ctx.ui.notify(`pi-peak: no peak hours configured for ${key}`, "info");
						return;
					}
					if (writeModelConfig(ctx, key, undefined)) {
						ctx.ui.notify(`pi-peak: cleared peak hours for ${key}`, "info");
					}
					return;
				}
				case "help":
				case "?": {
					showHelp(ctx);
					return;
				}
				default: {
					// `/peak <spec>` and `/peak <preset>` work without a subcommand.
					const model = requireModel(ctx);
					if (!model) return;
					const key = modelKey(model.provider, model.id);
					if (allPresets(config)[trimmed]) {
						applyPreset(ctx, key, trimmed);
						return;
					}
					if (!applySpec(ctx, key, trimmed, config.models[key]?.frame)) {
						ctx.ui.notify("pi-peak: run /peak help for usage.", "info");
					}
				}
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const warnings = reload();
		lastStatus = undefined;
		updateStatus(ctx);

		stopTimer();
		if (ctx.hasUI) {
			const handle = setInterval(() => {
				if (fileStamp(configFilePath) !== configStamp) reload();
				updateStatus(ctx);
			}, REFRESH_INTERVAL_MS) as ReturnType<typeof setInterval> & { unref?: () => void };
			handle.unref?.();
			timer = handle;
		}

		if (warnings.length > 0) {
			ctx.ui.notify(`pi-peak: ${warnings.join(" ")}`, "warning");
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		lastStatus = undefined;
	});
}

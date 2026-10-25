/**
 * Persistence for peak-hour config.
 *
 * Stored in `$PI_AGENT_DIR/peak-hours.json` (default `~/.pi/agent/peak-hours.json`)
 * so a window configured for `deepseek/deepseek-chat` applies to every session and project.
 *
 * Shape:
 * ```json
 * {
 *   "version": 1,
 *   "models": {
 *     "deepseek/deepseek-chat": {
 *       "frame": "utc",
 *       "windows": [{ "start": "01:00", "end": "04:00" }, { "start": "06:00", "end": "10:00" }],
 *       "preset": "deepseek"
 *     },
 *     "deepseek/*": { "frame": "utc", "windows": [] }
 *   },
 *   "presets": {
 *     "my-provider": { "description": "…", "frame": "utc", "windows": [] }
 *   }
 * }
 * ```
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type PeakWindow, type TimeFrame, formatWindowList, parseClockToken } from "./windows.ts";

export const CONFIG_VERSION = 1;
export const CONFIG_FILENAME = "peak-hours.json";

export interface PeakPreset {
	description?: string;
	frame: TimeFrame;
	windows: PeakWindow[];
}

export interface ModelPeakConfig {
	frame: TimeFrame;
	windows: PeakWindow[];
	/** Name of the preset this config came from, when it was applied from one. */
	preset?: string;
	/** ISO timestamp of the last edit. */
	updatedAt?: string;
}

export interface PeakConfigFile {
	version: number;
	models: Record<string, ModelPeakConfig>;
	presets: Record<string, PeakPreset>;
}

/**
 * Shipped presets. `deepseek` mirrors the peak windows DeepSeek publishes
 * (UTC 01:00-04:00 and 06:00-10:00), which is the example this plugin was built for.
 */
export const BUILTIN_PRESETS: Record<string, PeakPreset> = {
	deepseek: {
		description: "DeepSeek peak hours (UTC 01:00-04:00, 06:00-10:00)",
		frame: "utc",
		windows: [
			{ start: "01:00", end: "04:00" },
			{ start: "06:00", end: "10:00" },
		],
	},
	"local-business": {
		description: "Local business hours 09:00-17:00",
		frame: "local",
		windows: [{ start: "09:00", end: "17:00" }],
	},
	"utc-business": {
		description: "UTC business hours 08:00-17:00",
		frame: "utc",
		windows: [{ start: "08:00", end: "17:00" }],
	},
};

export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILENAME);
}

export function emptyConfig(): PeakConfigFile {
	return { version: CONFIG_VERSION, models: {}, presets: {} };
}

export function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/**
 * Resolve a model's config: exact `provider/model`, then the `provider/*`
 * wildcard, then the `*` catch-all.
 */
export function lookupConfig(
	config: PeakConfigFile,
	provider: string,
	id: string,
): { key: string; entry: ModelPeakConfig } | undefined {
	const candidates = [modelKey(provider, id), `${provider}/*`, "*"];
	for (const key of candidates) {
		const entry = config.models[key];
		if (entry && entry.windows.length > 0) return { key, entry };
	}
	return undefined;
}

/** All presets, built-ins first, user presets overriding names they share. */
export function allPresets(config: PeakConfigFile): Record<string, PeakPreset> {
	return { ...BUILTIN_PRESETS, ...config.presets };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWindows(value: unknown): PeakWindow[] {
	if (!Array.isArray(value)) return [];
	const windows: PeakWindow[] = [];
	for (const item of value) {
		if (!isObject(item)) continue;
		const start = typeof item.start === "string" ? parseClockToken(item.start) : undefined;
		const end = typeof item.end === "string" ? parseClockToken(item.end) : undefined;
		if (start === undefined || end === undefined || start === end) continue;
		windows.push({ start: formatClockSafe(start), end: formatClockSafe(end) });
	}
	return windows;
}

function formatClockSafe(minutes: number): string {
	const normalized = minutes === 1440 ? 1440 : ((minutes % 1440) + 1440) % 1440;
	const hours = Math.floor(normalized / 60);
	const mins = normalized % 60;
	return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function normalizeEntry(value: unknown): ModelPeakConfig | undefined {
	if (!isObject(value)) return undefined;
	const frame: TimeFrame = value.frame === "local" ? "local" : "utc";
	const windows = normalizeWindows(value.windows);
	if (windows.length === 0) return undefined;
	const entry: ModelPeakConfig = { frame, windows };
	if (typeof value.preset === "string" && value.preset) entry.preset = value.preset;
	if (typeof value.updatedAt === "string") entry.updatedAt = value.updatedAt;
	return entry;
}

export interface LoadResult {
	config: PeakConfigFile;
	path: string;
	warnings: string[];
}

/** Read the config file, dropping invalid entries instead of failing. */
export function loadConfig(path: string = configPath()): LoadResult {
	const config = emptyConfig();
	const warnings: string[] = [];

	if (!existsSync(path)) return { config, path, warnings };

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		warnings.push(`Could not parse ${path}: ${(error as Error).message}. Using an empty config.`);
		return { config, path, warnings };
	}

	if (!isObject(parsed)) {
		warnings.push(`${path} is not a JSON object. Using an empty config.`);
		return { config, path, warnings };
	}

	if (isObject(parsed.models)) {
		for (const [key, value] of Object.entries(parsed.models)) {
			const entry = normalizeEntry(value);
			if (entry) config.models[key] = entry;
			else warnings.push(`Ignoring peak config for "${key}" in ${path}: no valid windows.`);
		}
	}

	if (isObject(parsed.presets)) {
		for (const [name, value] of Object.entries(parsed.presets)) {
			if (!isObject(value)) continue;
			const windows = normalizeWindows(value.windows);
			if (windows.length === 0) {
				warnings.push(`Ignoring preset "${name}" in ${path}: no valid windows.`);
				continue;
			}
			const preset: PeakPreset = { frame: value.frame === "local" ? "local" : "utc", windows };
			if (typeof value.description === "string") preset.description = value.description;
			config.presets[name] = preset;
		}
	}

	return { config, path, warnings };
}

/** Write the config atomically (temp file + rename). */
export function saveConfig(config: PeakConfigFile, path: string = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ ...config, version: CONFIG_VERSION }, null, "\t")}\n`, "utf-8");
	renameSync(tmp, path);
}

export function setModelConfig(
	config: PeakConfigFile,
	key: string,
	next: Omit<ModelPeakConfig, "updatedAt"> | undefined,
): void {
	if (!next) {
		delete config.models[key];
		return;
	}
	config.models[key] = { ...next, updatedAt: new Date().toISOString() };
}

/** Remove the config file entirely. Returns false when there was nothing to remove. */
export function deleteConfigFile(path: string = configPath()): boolean {
	if (!existsSync(path)) return false;
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

/** One-line summary for pickers and `/peak list`. */
export function describeModelConfig(entry: ModelPeakConfig): string {
	const zone = entry.frame === "utc" ? "UTC" : "local";
	const preset = entry.preset ? ` · preset:${entry.preset}` : "";
	return `${zone} ${formatWindowList(entry.windows)}${preset}`;
}

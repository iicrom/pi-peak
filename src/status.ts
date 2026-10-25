/**
 * Status-bar text and the detailed `/peak status` description.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelPeakConfig } from "./config.ts";
import {
	currentClock,
	evaluatePeak,
	formatDuration,
	formatWindowList,
	frameLabel,
	type PeakState,
} from "./windows.ts";

/** Footer status key; the built-in footer renders extension statuses on their own line. */
export const STATUS_KEY = "peak";

/**
 * One line for the status bar:
 *
 * ```
 * PEAK · ends in 2h05m (UTC 01:00-04:00, 06:00-10:00)
 * OFF-PEAK · next peak in 1h20m (UTC 01:00-04:00, 06:00-10:00)
 * ```
 */
export function renderStatusLine(config: ModelPeakConfig, state: PeakState, theme: Theme): string | undefined {
	if (!state.hasWindows) return undefined;

	const zone = frameLabel(config.frame);
	const windows = formatWindowList(config.windows);
	const suffix = theme.fg("dim", ` (${zone} ${windows})`);

	if (state.peak) {
		const timing =
			state.msUntilChange === null ? "all day" : `ends in ${formatDuration(state.msUntilChange)}`;
		return `${theme.fg("warning", theme.bold("PEAK"))}${theme.fg("dim", ` · ${timing}`)}${suffix}`;
	}

	const timing =
		state.msUntilChange === null ? "no upcoming peak" : `next peak in ${formatDuration(state.msUntilChange)}`;
	return `${theme.fg("success", "OFF-PEAK")}${theme.fg("dim", ` · ${timing}`)}${suffix}`;
}

/** Multi-line summary used by `/peak status` and after saving a config. */
export function describeState(modelLabel: string, config: ModelPeakConfig, now: Date): string {
	const state = evaluatePeak(config.windows, now, config.frame);
	const zone = frameLabel(config.frame);
	const lines: string[] = [];

	const verdict = state.peak ? "PEAK hours" : "off-peak";
	lines.push(`${modelLabel} — ${verdict}${config.preset ? ` (preset: ${config.preset})` : ""}`);
	lines.push(`now ${currentClock(now, config.frame)} ${zone} · windows ${zone} ${formatWindowList(config.windows)}`);

	if (state.msUntilChange !== null) {
		const next = new Date(now.getTime() + state.msUntilChange);
		const nextLabel = state.peak ? "peak ends" : "peak starts";
		lines.push(`${nextLabel} in ${formatDuration(state.msUntilChange)} (${currentClock(next, config.frame)} ${zone})`);
	} else if (state.hasWindows) {
		lines.push(state.peak ? "peak covers the whole day" : "no upcoming peak");
	}

	return lines.join("\n");
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	currentClock,
	evaluatePeak,
	formatClock,
	formatDuration,
	formatWindowList,
	parseClockToken,
	parseWindowSpec,
	windowSegments,
} from "./windows.ts";

test("parseClockToken accepts common shapes", () => {
	assert.equal(parseClockToken("0"), 0);
	assert.equal(parseClockToken("1"), 60);
	assert.equal(parseClockToken("01:30"), 90);
	assert.equal(parseClockToken("0130"), 90);
	assert.equal(parseClockToken("1:30pm"), 13 * 60 + 30);
	assert.equal(parseClockToken("12:00am"), 0);
	assert.equal(parseClockToken("12:00pm"), 12 * 60);
	assert.equal(parseClockToken("24:00"), 1440);
	assert.equal(parseClockToken("25:00"), undefined);
	assert.equal(parseClockToken("10:75"), undefined);
	assert.equal(parseClockToken("noon"), undefined);
});

test("parseWindowSpec handles the DeepSeek spec", () => {
	const parsed = parseWindowSpec("utc 01:00-04:00 06:00-10:00");
	assert.equal(parsed.error, undefined);
	assert.equal(parsed.frame, "utc");
	assert.deepEqual(parsed.windows, [
		{ start: "01:00", end: "04:00" },
		{ start: "06:00", end: "10:00" },
	]);
});

test("parseWindowSpec normalizes separators and frames", () => {
	assert.deepEqual(parseWindowSpec("1-4, 6-10").windows, [
		{ start: "01:00", end: "04:00" },
		{ start: "06:00", end: "10:00" },
	]);
	assert.deepEqual(parseWindowSpec("01:00–04:00").windows, [{ start: "01:00", end: "04:00" }]);
	assert.deepEqual(parseWindowSpec("01:00 to 04:00").windows, [{ start: "01:00", end: "04:00" }]);
	assert.equal(parseWindowSpec("local 9-17").frame, "local");
	assert.deepEqual(parseWindowSpec("local 9:00pm-2:00am").windows, [{ start: "21:00", end: "02:00" }]);
});

test("parseWindowSpec reports problems", () => {
	assert.ok(parseWindowSpec("").error);
	assert.ok(parseWindowSpec("01:00-01:00").error);
	assert.ok(parseWindowSpec("nonsense").error);
	const trailing = parseWindowSpec("01:00-04:00 banana");
	assert.ok(trailing.error?.includes("banana"));
});

test("windowSegments splits midnight-spanning windows", () => {
	assert.deepEqual(windowSegments([{ start: "22:00", end: "02:00" }]), [
		[1320, 1440],
		[0, 120],
	]);
	assert.deepEqual(windowSegments([{ start: "01:00", end: "04:00" }]), [[60, 240]]);
	assert.deepEqual(windowSegments([{ start: "00:00", end: "24:00" }]), [[0, 1440]]);
	assert.deepEqual(windowSegments([]), []);
});

test("evaluatePeak reports state and countdown", () => {
	const windows = [
		{ start: "01:00", end: "04:00" },
		{ start: "06:00", end: "10:00" },
	];

	const insidePeak = evaluatePeak(windows, new Date(Date.UTC(2024, 0, 1, 3, 0, 0)), "utc");
	assert.equal(insidePeak.peak, true);
	assert.equal(insidePeak.msUntilChange, 60 * 60_000);

	const beforePeak = evaluatePeak(windows, new Date(Date.UTC(2024, 0, 1, 0, 20, 0)), "utc");
	assert.equal(beforePeak.peak, false);
	assert.equal(beforePeak.minutesUntilChange, 40);

	const betweenWindows = evaluatePeak(windows, new Date(Date.UTC(2024, 0, 1, 5, 0, 0)), "utc");
	assert.equal(betweenWindows.peak, false);
	assert.equal(betweenWindows.minutesUntilChange, 60);

	// 23:00 wraps to the next day's 01:00 window.
	const lateNight = evaluatePeak(windows, new Date(Date.UTC(2024, 0, 1, 23, 0, 0)), "utc");
	assert.equal(lateNight.peak, false);
	assert.equal(lateNight.minutesUntilChange, 120);
});

test("evaluatePeak handles all-day and empty configs", () => {
	const allDay = evaluatePeak([{ start: "00:00", end: "24:00" }], new Date(Date.UTC(2024, 0, 1, 12, 0, 0)), "utc");
	assert.equal(allDay.peak, true);
	assert.equal(allDay.msUntilChange, null);

	const none = evaluatePeak([], new Date(), "utc");
	assert.equal(none.peak, false);
	assert.equal(none.hasWindows, false);
});

test("evaluatePeak uses the local frame", () => {
	const local = new Date(2024, 0, 1, 10, 30, 0);
	const state = evaluatePeak([{ start: "10:00", end: "11:00" }], local, "local");
	assert.equal(state.peak, true);
	assert.equal(currentClock(local, "local"), "10:30");
	assert.equal(currentClock(new Date(Date.UTC(2024, 0, 1, 10, 30, 0)), "utc"), "10:30");
});

test("formatDuration and friends", () => {
	assert.equal(formatDuration(30_000), "<1m");
	assert.equal(formatDuration(45 * 60_000), "45m");
	assert.equal(formatDuration(80 * 60_000), "1h20m");
	assert.equal(formatDuration(120 * 60_000), "2h");
	assert.equal(formatClock(0), "00:00");
	assert.equal(formatClock(1440), "00:00");
	assert.equal(formatWindowList([{ start: "01:00", end: "04:00" }]), "01:00-04:00");
});

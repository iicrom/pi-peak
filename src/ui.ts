/**
 * Small UI helpers shared by the /peak command flows.
 *
 * In TUI mode a searchable `SelectList` is used (typing filters, like the built-in
 * model picker). Other dialog-capable modes (RPC) fall back to `ctx.ui.select()`.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export interface PickOptions {
	/** Key of the item to preselect, so Enter accepts the current value. */
	preselect?: string;
	/** Footer hint line. */
	hint?: string;
	/** Extra line rendered under the title. */
	subtitle?: string;
}

const DEFAULT_HINT = "type to filter · ↑↓ navigate · enter select · esc cancel";
const MAX_VISIBLE = 12;

/**
 * Substring filter over value, label, and description. Every whitespace-separated
 * token must match, so `"deep chat"` finds `deepseek/deepseek-chat`.
 */
export function filterItems(items: SelectItem[], query: string): SelectItem[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return items;
	const tokens = needle.split(/\s+/);
	return items.filter((item) => {
		const haystack = `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
}

/** Show a searchable single-choice list. Returns the selected item's value. */
export async function pickWithList(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	options: PickOptions = {},
): Promise<string | undefined> {
	if (!ctx.hasUI || items.length === 0) return undefined;

	if (ctx.mode !== "tui") {
		const labels = items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label));
		const chosen = await ctx.ui.select(title, labels);
		if (chosen === undefined) return undefined;
		return items[labels.indexOf(chosen)]?.value;
	}

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const container = new Container();
		const border = (text: string) => theme.fg("borderAccent", text);
		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};

		const buildList = (visible: SelectItem[], preselectValue?: string): SelectList => {
			const list = new SelectList(visible, Math.max(1, Math.min(visible.length, MAX_VISIBLE)), listTheme);
			if (preselectValue) {
				const index = visible.findIndex((item) => item.value === preselectValue);
				if (index >= 0) list.setSelectedIndex(index);
			}
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			return list;
		};

		let list = buildList(items, options.preselect);

		container.addChild(new DynamicBorder(border));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		if (options.subtitle) {
			container.addChild(new Text(theme.fg("muted", options.subtitle), 1, 0));
		}

		const search = new Input({
			placeholder: "filter…",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		search.focused = true;
		search.onSubmit = () => list.handleInput("\r");
		search.onEscape = () => done(undefined);
		container.addChild(search);

		container.addChild(list);
		const listIndex = container.children.length - 1;

		container.addChild(new Text(theme.fg("dim", options.hint ?? DEFAULT_HINT), 1, 0));
		container.addChild(new DynamicBorder(border));

		const applyFilter = () => {
			const query = search.getValue();
			const visible = filterItems(items, query);
			// Skip the preselect once the user is searching, so Enter takes the top hit.
			const next = buildList(visible, query ? undefined : options.preselect);
			container.children[listIndex] = next;
			list = next;
			container.invalidate();
		};

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				search.invalidate();
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					list.handleInput(data);
				} else {
					search.handleInput(data);
					applyFilter();
				}
				tui.requestRender();
			},
		};
	});
}

/** Ask for a free-form window spec. Returns undefined when cancelled. */
export async function inputWindowSpec(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const value = await ctx.ui.input(title, placeholder);
	return value?.trim() || undefined;
}

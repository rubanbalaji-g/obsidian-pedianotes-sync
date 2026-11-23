import { App } from "obsidian";
import { MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";

export function confirmVault(app: App, settings: PediaNotesPluginSettings, action: string): boolean {
  return window.confirm(
    `Confirm vault before ${action}\n\n` +
    `Obsidian vault: ${app.vault.getName()}\n` +
    `PediaNotes module: ${settings.module.toUpperCase()}\n` +
    `Site: ${MODULE_URLS[settings.module] || "Unknown — do not continue"}\n\n` +
    `Only continue if this is the correct vault and destination.`
  );
}

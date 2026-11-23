import { App, Modal } from "obsidian";
import { MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";

function confirmDialog(app: App, title: string, message: string, requiredText?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const dialog = new Modal(app);
    const finish = (value: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
      dialog.close();
    };
    dialog.onOpen = () => {
      dialog.contentEl.createEl("h2", { text: title });
      dialog.contentEl.createEl("p", { text: message, attr: { style: "white-space: pre-line;" } });
      let input: HTMLInputElement | undefined;
      if (requiredText) {
        input = dialog.contentEl.createEl("input", {
          type: "text",
          placeholder: `Type ${requiredText}`,
          attr: { style: "width:100%;margin-bottom:12px;" },
        });
      }
      const buttons = dialog.contentEl.createDiv({ attr: { style: "display:flex;gap:8px;justify-content:flex-end;" } });
      buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => finish(false));
      const confirm = buttons.createEl("button", { text: "Continue", cls: "mod-cta" });
      if (input) {
        confirm.disabled = true;
        input.addEventListener("input", () => { confirm.disabled = input!.value !== requiredText; });
      }
      confirm.addEventListener("click", () => finish(!requiredText || input?.value === requiredText));
    };
    dialog.onClose = () => {
      dialog.contentEl.empty();
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    };
    dialog.open();
  });
}

export function confirmVault(app: App, settings: PediaNotesPluginSettings, action: string): Promise<boolean> {
  return confirmDialog(app, "Confirm vault", `Before ${action}:\n\nObsidian vault: ${app.vault.getName()}\nPediaNotes module: ${settings.module.toUpperCase()}\nSite: ${MODULE_URLS[settings.module] || "Unknown — do not continue"}\n\nOnly continue if this is the correct vault and destination.`);
}

export function confirmCanonicalReplacement(app: App): Promise<boolean> {
  return confirmDialog(app, "Replace P&O server notes", "This creates a GitHub backup branch, then replaces ALL P&O clinical Markdown notes with vault notes marked publish: true. Server-only notes will be removed from main. Site layouts and existing assets are preserved.\n\nType REPLACE to continue.", "REPLACE");
}

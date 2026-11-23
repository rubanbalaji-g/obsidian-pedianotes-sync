import { App, Modal } from "obsidian";
import { MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";

export class PullReminderModal extends Modal {
  constructor(app: App, private settings: PediaNotesPluginSettings, private pull: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Pull the latest PediaNotes updates" });
    contentEl.createEl("p", { text: "Before you start editing, check for updates from PediaNotes." });
    contentEl.createEl("p", {
      text: `Vault: ${this.app.vault.getName()}\nModule: ${this.settings.module.toUpperCase()}\nSite: ${MODULE_URLS[this.settings.module] || "Unknown"}`,
      attr: { style: "white-space: pre-line;" },
    });
    const pull = contentEl.createEl("button", {
      text: "⬇ Pull latest updates",
      cls: "mod-cta",
      attr: { style: "width: 100%; padding: 14px; font-size: 1.1em;" },
    });
    pull.addEventListener("click", () => {
      this.close();
      this.pull();
    });
    const close = contentEl.createEl("button", { text: "Not now", attr: { style: "width: 100%; margin-top: 8px;" } });
    close.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

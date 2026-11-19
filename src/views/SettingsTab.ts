import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import PediaNotesSyncPlugin from "src/main";
import { AUTH_PORTAL_URL, PediaModule } from "src/models/settings";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: PediaNotesSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "PediaNotes Collaborator Sync" });

    // Account Status Box
    const statusDesc = this.plugin.settings.token
      ? `Connected as ${this.plugin.settings.userName || "Member"} (${this.plugin.settings.userEmail}) • Allowed: ${
          this.plugin.settings.allowedModules.join(", ").toUpperCase() || "checking..."
        }`
      : "Not connected. Sign in with your PediaNotes Google or Email account.";

    new Setting(containerEl)
      .setName("PediaNotes Account")
      .setDesc(statusDesc)
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.settings.token ? "Reconnect Account" : "Sign In with PediaNotes")
          .setCta()
          .onClick(() => {
            window.open(`${AUTH_PORTAL_URL}/plugin-auth`, "_blank");
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Verify").onClick(async () => {
          try {
            const info = await this.plugin.verifyAndRefreshAuth();
            new Notice(`✅ Verified: ${info.email} (${info.allowedModules.join(", ")})`);
            this.display();
          } catch (err: any) {
            new Notice(`❌ ${err.message}`);
          }
        })
      );

    new Setting(containerEl)
      .setName("Manual Login Token (Fallback)")
      .setDesc("Only needed if the 'Open in Obsidian' browser redirect didn't trigger automatically.")
      .addText((txt) =>
        txt
          .setPlaceholder("Paste token from auth.pedianotes.in/plugin-auth")
          .setValue(this.plugin.settings.token)
          .onChange(async (val) => {
            this.plugin.settings.token = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Display Name (Author Attribution)")
      .setDesc("Name shown as 'By <Your Name>' on notes you edit or create.")
      .addText((txt) =>
        txt
          .setPlaceholder(this.plugin.settings.userName || "e.g. Dr. Priya S")
          .setValue(this.plugin.settings.displayName)
          .onChange(async (val) => {
            this.plugin.settings.displayName = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Target PediaNotes Site (Vault Module)")
      .setDesc("Choose which PediaNotes knowledge base this Obsidian vault syncs with.")
      .addDropdown((dd) => {
        dd.addOption("theory", "DNB Theory (theory.pedianotes.in)");
        dd.addOption("practical", "DNB Practicals (practical.pedianotes.in)");
        dd.addOption("osce", "DNB OSCE (osce.pedianotes.in)");
        dd.setValue(this.plugin.settings.module);
        dd.onChange(async (val) => {
          this.plugin.settings.module = val as PediaModule;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-Pull Updates When Obsidian Opens")
      .setDesc("Recommended: Automatically pulls latest notes from the web editor & other collaborators on startup.")
      .addToggle((tog) =>
        tog.setValue(this.plugin.settings.autoPullOnOpen).onChange(async (val) => {
          this.plugin.settings.autoPullOnOpen = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Publish All Notes (Ignore 'publish: true' Filter)")
      .setDesc("Enable if you want every Markdown file in this vault synced; leave OFF to sync only notes with 'publish: true'.")
      .addToggle((tog) =>
        tog.setValue(this.plugin.settings.publishAllNotes).onChange(async (val) => {
          this.plugin.settings.publishAllNotes = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Local Image Folder")
      .setDesc("Folder inside this vault where pulled images are saved (e.g. 'img' or 'images').")
      .addText((txt) =>
        txt
          .setPlaceholder("img")
          .setValue(this.plugin.settings.imageFolder)
          .onChange(async (val) => {
            this.plugin.settings.imageFolder = val.trim() || "img";
            await this.plugin.saveSettings();
          })
      );
  }
}

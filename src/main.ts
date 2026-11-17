import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";
import { PediaNotesClient } from "src/api/PediaNotesClient";
import { SyncEngine } from "src/sync/SyncEngine";
import { SyncModal } from "src/views/SyncModal";
import { NavigationOrderModal } from "src/views/NavigationOrderModal";
import { SettingsTab } from "src/views/SettingsTab";

export default class PediaNotesSyncPlugin extends Plugin {
  settings: PediaNotesPluginSettings = DEFAULT_SETTINGS;
  engine: SyncEngine;
  private statusBarItem: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.engine = new SyncEngine(
      this.app.vault,
      this.app.metadataCache,
      this.settings,
      () => this.saveSettings()
    );

    // Handle obsidian://pedianotes-auth?token=...
    this.registerObsidianProtocolHandler("pedianotes-auth", async (params) => {
      const token = (params.token || "").trim();
      if (!token) {
        new Notice("❌ No PediaNotes login token received.");
        return;
      }
      this.settings.token = token;
      await this.saveSettings();
      try {
        const info = await this.verifyAndRefreshAuth();
        new Notice(`✅ Connected to PediaNotes as ${info.name} (${info.email})`);
        if (this.settings.autoPullOnOpen) {
          await this.runAutoPull(true);
        }
      } catch (err: any) {
        new Notice(`❌ Auth verification failed: ${err.message}`);
      }
    });

    this.addRibbonIcon("refresh-cw", "PediaNotes 2-Way Sync Center", () => {
      new SyncModal(this.app, this.engine, this.settings, () => this.updateStatusBar()).open();
    });

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("pn-status-bar");
    this.updateStatusBar();
    this.statusBarItem.onClickEvent(() => {
      new SyncModal(this.app, this.engine, this.settings, () => this.updateStatusBar()).open();
    });

    this.addCommand({
      id: "open-pedianotes-sync-center",
      name: "Open PediaNotes Sync Center",
      callback: () => {
        new SyncModal(this.app, this.engine, this.settings, () => this.updateStatusBar()).open();
      },
    });

    this.addCommand({
      id: "pull-from-pedianotes",
      name: "Pull Latest Notes from PediaNotes",
      callback: () => this.runAutoPull(false),
    });

    this.addCommand({
      id: "publish-current-note",
      name: "Publish Current Note to PediaNotes",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) this.publishSingle(file);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "reorder-section-navigation",
      name: "Reorder Section Navigation (Set Weight)",
      callback: () => new NavigationOrderModal(this.app).open(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Publish Note to PediaNotes")
              .setIcon("upload-cloud")
              .onClick(() => this.publishSingle(file))
          );
        }
      })
    );

    this.addSettingTab(new SettingsTab(this.app, this));

    // Auto-pull latest notes & images whenever Obsidian opens
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.token && this.settings.autoPullOnOpen) {
        this.runAutoPull(true);
      }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.engine) {
      this.engine.updateSettings(this.settings);
    }
    this.updateStatusBar();
  }

  async verifyAndRefreshAuth() {
    const client = new PediaNotesClient(this.settings);
    const info = await client.ping();
    this.settings.userEmail = info.email;
    this.settings.userName = info.name;
    this.settings.isAdmin = info.isAdmin;
    this.settings.allowedModules = info.allowedModules || [];
    await this.saveSettings();
    return info;
  }

  private async runAutoPull(silentIfClean: boolean) {
    if (!this.settings.token) return;
    try {
      this.setStatusBarText("🔄 PediaNotes: Checking updates...");
      const plan = await this.engine.computeSyncPlan();
      const pullCount = plan.toPullNotes.length + plan.toPullAssets.length;
      if (pullCount > 0) {
        const pulled = await this.engine.pullFromServer(plan);
        new Notice(`⬇️ PediaNotes pulled ${pulled} updated file(s).`);
      } else if (!silentIfClean) {
        new Notice("✨ PediaNotes is already up to date.");
      }

      if (plan.conflicts.length > 0) {
        this.setStatusBarText(`⚠️ PediaNotes: ${plan.conflicts.length} conflict(s)`);
        new Notice(`⚠️ ${plan.conflicts.length} note(s) have sync conflicts. Open Sync Center to resolve.`);
      } else {
        this.updateStatusBar();
      }
    } catch (err: any) {
      this.updateStatusBar();
      if (!silentIfClean) {
        new Notice(`❌ PediaNotes sync failed: ${err.message}`);
      }
    }
  }

  private async publishSingle(file: TFile) {
    if (!this.settings.token) {
      new Notice("Please sign in to PediaNotes in plugin settings first.");
      return;
    }
    const fm = this.app.metadataCache.getCache(file.path)?.frontmatter;
    if (!this.settings.publishAllNotes && fm?.["publish"] !== true) {
      await this.app.fileManager.processFrontMatter(file, (f) => {
        f["publish"] = true;
      });
    }
    new Notice(`Publishing ${file.basename} to ${MODULE_URLS[this.settings.module]}...`);
    try {
      const res = await this.engine.publishSingleNote(file);
      new Notice(`✅ Published ${file.basename}! (${res.build?.ms || 0}ms)`);
      this.updateStatusBar();
    } catch (err: any) {
      if (err.status === 409) {
        new Notice("⚠️ Conflict: this note was modified on the server. Opening Sync Center...");
        new SyncModal(this.app, this.engine, this.settings, () => this.updateStatusBar()).open();
      } else {
        new Notice(`❌ Publish failed: ${err.message}`);
      }
    }
  }

  private setStatusBarText(text: string) {
    if (this.statusBarItem) this.statusBarItem.setText(text);
  }

  private updateStatusBar() {
    if (!this.statusBarItem) return;
    if (!this.settings.token) {
      this.statusBarItem.setText("🔒 PediaNotes: Sign In");
      return;
    }
    const mod = this.settings.module.toUpperCase();
    const count = this.engine?.getPublishableFiles().length ?? 0;
    this.statusBarItem.setText(`🩺 PediaNotes (${mod}): ${count}`);
  }
}

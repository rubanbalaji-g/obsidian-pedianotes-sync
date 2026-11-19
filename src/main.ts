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

    this.addRibbonIcon("refresh-cw", "PediaNotes Syncer", () => {
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
      name: "Open PediaNotes Syncer",
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
      id: "pull-all-from-pedianotes",
      name: "Pull All Notes & Images from PediaNotes Server",
      callback: async () => {
        new Notice("⬇️ Pulling all notes & images from PediaNotes...");
        try {
          const count = await this.engine.pullAllFromServer();
          new Notice(`✅ Pulled ${count} file(s) from PediaNotes`);
          this.updateStatusBar();
        } catch (err: any) {
          new Notice(`❌ Pull failed: ${err.message}`);
        }
      },
    });

    this.addCommand({
      id: "open-current-note-on-web",
      name: "Open Current Note on PediaNotes Web",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) window.open(this.getWebUrlForFile(file), "_blank");
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
          menu.addItem((item) =>
            item
              .setTitle("Open on PediaNotes Web")
              .setIcon("external-link")
              .onClick(() => window.open(this.getWebUrlForFile(file), "_blank"))
          );
          menu.addItem((item) =>
            item
              .setTitle("Copy PediaNotes Link")
              .setIcon("link")
              .onClick(() => {
                navigator.clipboard.writeText(this.getWebUrlForFile(file));
                new Notice("🔗 Copied PediaNotes URL");
              })
          );
        }
      })
    );

    this.addSettingTab(new SettingsTab(this.app, this));

    // Retry offline queue when network comes back online
    this.registerDomEvent(window, "online", () => {
      this.flushOfflineQueue();
    });

    // Auto-pull latest notes & images whenever Obsidian opens
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.token && this.settings.autoPullOnOpen) {
        this.runAutoPull(true);
      }
      this.flushOfflineQueue();
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
      } else if (!navigator.onLine || /network|failed to fetch|timeout/i.test(String(err.message))) {
        if (!this.settings.offlineQueue.includes(file.path)) {
          this.settings.offlineQueue.push(file.path);
          await this.saveSettings();
        }
        new Notice(`📴 Offline: Queued "${file.basename}" to publish automatically when back online.`);
      } else {
        new Notice(`❌ Publish failed: ${err.message}`);
      }
    }
  }

  private async flushOfflineQueue() {
    if (!this.settings.token || !navigator.onLine || !this.settings.offlineQueue?.length) return;
    const queue = [...this.settings.offlineQueue];
    const remaining: string[] = [];
    for (const filePath of queue) {
      const f = this.app.vault.getAbstractFileByPath(filePath);
      if (f instanceof TFile) {
        try {
          await this.engine.publishSingleNote(f);
          new Notice(`✅ Synced queued note: ${f.basename}`);
        } catch {
          remaining.push(filePath);
        }
      }
    }
    this.settings.offlineQueue = remaining;
    await this.saveSettings();
    this.updateStatusBar();
  }

  private getWebUrlForFile(file: TFile): string {
    const base = MODULE_URLS[this.settings.module];
    const slug = file.path
      .replace(/\.md$/i, "")
      .split("/")
      .map((s) =>
        s
          .toLowerCase()
          .replace(/[^\w\s-]/g, " ")
          .trim()
          .replace(/[\s_]+/g, "-")
          .replace(/-+/g, "-")
      )
      .filter(Boolean)
      .join("/");
    return `${base}/${slug}/`;
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

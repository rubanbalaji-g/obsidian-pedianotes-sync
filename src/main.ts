import { Notice, Plugin, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";
import { PediaNotesClient } from "src/api/PediaNotesClient";
import { SyncEngine } from "src/sync/SyncEngine";
import { SyncView, VIEW_TYPE_PEDIANOTES_SYNC } from "src/views/SyncView";
import { NavigationOrderModal } from "src/views/NavigationOrderModal";
import { SettingsTab } from "src/views/SettingsTab";
import { confirmVault } from "src/utils/confirmVault";
import { confirmPullFiles } from "src/utils/confirmPull";
import { PullReminderModal } from "src/views/PullReminderModal";
import { retireLegacyModule } from "src/models/moduleMigration";

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
      } catch (err: any) {
        new Notice(`❌ Auth verification failed: ${err.message}`);
      }
    });

    this.registerView(
      VIEW_TYPE_PEDIANOTES_SYNC,
      (leaf: WorkspaceLeaf) =>
        new SyncView(leaf, this, this.engine, this.settings, () => this.updateStatusBar())
    );

    this.addRibbonIcon("refresh-cw", "PediaNotes Syncer", () => {
      void this.openSyncTab();
    });

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("pn-status-bar");
    this.updateStatusBar();
    this.statusBarItem.onClickEvent(() => {
      void this.openSyncTab();
    });

    this.addCommand({
      id: "open-pedianotes-sync-center",
      name: "Open PediaNotes Syncer",
      callback: () => {
        void this.openSyncTab();
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
        new Notice("🔍 Checking server files...");
        try {
          const serverFiles = await this.engine.getServerManifestFiles();
          if (serverFiles.length === 0) {
            new Notice("✨ No files found on the PediaNotes server.");
            return;
          }
          if (!(await confirmPullFiles(this.app, this.settings, "Pull All Files from Server", serverFiles))) return;
          new Notice("⬇️ Pulling all notes & images from PediaNotes...");
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
          if (!checking) {
            const url = this.getWebUrlForFile(file);
            if (url) window.open(url, "_blank");
          }
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
              .onClick(() => {
                const url = this.getWebUrlForFile(file);
                if (url) window.open(url, "_blank");
              })
          );
          menu.addItem((item) =>
            item
              .setTitle("Copy PediaNotes Link")
              .setIcon("link")
              .onClick(() => {
                const url = this.getWebUrlForFile(file);
                if (!url) return;
                navigator.clipboard.writeText(url);
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

    // Remind users to pull, but never pull automatically on startup.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.module === "unselected") {
        new Notice("The old Practical/OSCE site is retired. Select Theory or P&O in PediaNotes settings before syncing.", 12000);
      } else if (this.settings.token) {
        new PullReminderModal(this.app, this.settings, () => { void this.runAutoPull(false); }).open();
      }
    });
  }

  async openSyncTab() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PEDIANOTES_SYNC);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_PEDIANOTES_SYNC, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof SyncView) {
      await leaf.view.refresh();
    }
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!this.settings.vaultSetupCompleted && Object.keys(this.settings.baseShas || {}).length > 0) {
      this.settings.vaultSetupCompleted = true;
    }
    const oldModule = String(saved?.module || "");
    if (retireLegacyModule(this.settings, oldModule)) {
      await this.saveData(this.settings);
    }
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
    if (!(await confirmVault(this.app, this.settings, "pulling updates"))) return;
    try {
      this.setStatusBarText("🔄 PediaNotes: Checking updates...");
      if (!this.settings.themeSynced) {
        await this.engine.syncThemeFromServer().catch(() => {});
      }
      const plan = await this.engine.computeSyncPlan();
      const filesToPull = [
        ...plan.toPullNotes.map((f) => ({ path: f.path, type: "note" as const })),
        ...plan.toPullAssets.map((f) => ({ path: f.path, type: "asset" as const })),
      ];
      if (filesToPull.length > 0) {
        const confirmed = await confirmPullFiles(
          this.app,
          this.settings,
          "Pull Updates from Server",
          filesToPull
        );
        if (confirmed) {
          const pulled = await this.engine.pullFromServer(plan);
          new Notice(`⬇️ PediaNotes pulled ${pulled} updated file(s).`);
        }
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
    if (!(await confirmVault(this.app, this.settings, `publishing "${file.path}"`))) return;
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
        void this.openSyncTab();
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
    if (this.settings.module === "unselected" || !this.settings.token || !navigator.onLine || !this.settings.offlineQueue?.length) return;
    if (!(await confirmVault(this.app, this.settings, `publishing ${this.settings.offlineQueue.length} queued note(s)`))) return;
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
    if (!base) {
      new Notice("Select Theory or P&O in PediaNotes plugin settings first.");
      return "";
    }
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
    this.statusBarItem.empty();
    if (!this.settings.token) {
      this.statusBarItem.setText("🔒 PediaNotes: Sign In");
      return;
    }
    const mod = this.settings.module.toUpperCase();
    const count = this.engine?.getPublishableFiles().length ?? 0;
    const iconEl = this.statusBarItem.createSpan({ cls: "pn-status-icon" });
    setIcon(iconEl, "cross");
    this.statusBarItem.createSpan({ text: `PediaNotes (${mod}): ${count}` });
  }
}

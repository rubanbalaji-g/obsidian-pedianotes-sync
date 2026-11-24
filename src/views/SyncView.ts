import { App, ItemView, Modal, Notice, Plugin, setIcon, WorkspaceLeaf } from "obsidian";
import { AUTH_PORTAL_URL, MODULE_URLS, PediaModule, PediaNotesPluginSettings } from "src/models/settings";
import { SyncEngine, SyncPlan } from "src/sync/SyncEngine";
import { confirmCanonicalReplacement, confirmVault } from "src/utils/confirmVault";
import { confirmPullFiles } from "src/utils/confirmPull";
import { convertAllImagesToWebP, findUnusedImages, removeUnusedImages } from "src/utils/vaultImages";
import { checkLatestPluginRelease, updateSelfAndReload } from "src/utils/selfUpdater";
import { AdminUploadKitModal, installVaultKit } from "src/utils/vaultKit";

export const VIEW_TYPE_PEDIANOTES_SYNC = "pedianotes-sync-view";

function formatModuleLabel(mod: PediaModule): string {
  if (mod === "theory") return "DNB Theory";
  if (mod === "po") return "Practical & OSCE";
  return "Unselected";
}

function confirmActionModal(app: App, title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const modal = new Modal(app);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
      modal.close();
    };

    modal.onClose = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };

    modal.contentEl.createEl("h3", { text: title });
    modal.contentEl.createEl("p", { text: message });
    const row = modal.contentEl.createEl("div", {
      attr: { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;" },
    });
    const cancelBtn = row.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => finish(false));
    const okBtn = row.createEl("button", { text: confirmLabel, cls: "mod-cta" });
    okBtn.addEventListener("click", () => finish(true));
    modal.open();
  });
}

function createActionButton(
  parent: HTMLElement,
  iconName: string,
  label: string,
  cls?: string
): { button: HTMLButtonElement; setLabel: (txt: string) => void } {
  const button = parent.createEl("button", { cls: cls ? `pn-action-btn ${cls}` : "pn-action-btn" });
  const iconEl = button.createSpan({ cls: "pn-action-icon" });
  setIcon(iconEl, iconName);
  const textEl = button.createSpan({ text: label, cls: "pn-action-label" });
  return {
    button,
    setLabel: (txt: string) => {
      textEl.setText(txt);
    },
  };
}

export class SyncView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: Plugin & { saveSettings: () => Promise<void> },
    private engine: SyncEngine,
    private settings: PediaNotesPluginSettings,
    private onSyncComplete?: () => void
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PEDIANOTES_SYNC;
  }

  getDisplayText(): string {
    return "PediaNotes Syncer";
  }

  getIcon(): string {
    return "refresh-cw";
  }

  async onOpen() {
    await this.render();
  }

  public async refresh() {
    await this.render();
  }

  private async render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("pn-sync-view");

    // Prominent Vault & Site Identity Banner
    const siteUrl = MODULE_URLS[this.settings.module] || "Not configured";
    const siteLabel = formatModuleLabel(this.settings.module);
    const vaultName = this.app.vault.getName();

    const banner = container.createEl("div", { cls: "pn-identity-banner" });
    const identityLeft = banner.createEl("div", { cls: "pn-identity-left" });
    identityLeft.createEl("h2", { text: "PediaNotes Syncer", attr: { style: "margin:0 0 6px 0;" } });

    const metaRow = identityLeft.createEl("div", { cls: "pn-identity-meta" });
    const vaultPill = metaRow.createEl("span", { cls: "pn-identity-pill pn-pill-vault" });
    vaultPill.createEl("strong", { text: "Vault: " });
    vaultPill.createSpan({ text: vaultName });

    const sitePill = metaRow.createEl("span", { cls: "pn-identity-pill pn-pill-site" });
    sitePill.createEl("strong", { text: "Synced to: " });
    sitePill.createSpan({ text: `${siteLabel} (${siteUrl})` });

    const identityRight = banner.createEl("div", { cls: "pn-identity-right" });
    identityRight.createEl("span", {
      text: this.settings.userEmail || "Not Signed In",
      cls: "pn-sync-badge",
    });
    const refreshBtn = identityRight.createEl("button", { text: "↻ Refresh" });
    refreshBtn.addEventListener("click", () => {
      void this.render();
    });

    if (!this.settings.token || this.settings.module === "unselected" || !this.settings.vaultSetupCompleted) {
      await this.renderSetupWizard(container, vaultName);
      return;
    }

    // Prominent Update Banner (Syncer self-update & Vault Kit update)
    const updateBanner = container.createEl("div", { cls: "pn-update-banner", attr: { style: "display:none;" } });
    void this.populateUpdateBanner(updateBanner);

    const loadingEl = container.createEl("p", { text: "Comparing local vault with PediaNotes server..." });

    let plan: SyncPlan;
    try {
      plan = await this.engine.computeSyncPlan();
      loadingEl.remove();
    } catch (err: any) {
      loadingEl.setText(`❌ Sync check failed: ${err.message}`);
      return;
    }

    // Two-pane layout: Main Pane (left) + Right Side Pane (actions)
    const layout = container.createEl("div", { cls: "pn-sync-layout" });
    const mainPane = layout.createEl("div", { cls: "pn-main-pane" });
    const sidePane = layout.createEl("aside", { cls: "pn-side-pane" });

    // === MAIN PANE ===
    const stats = mainPane.createEl("div", { cls: "pn-sync-stats" });
    const addStat = (num: number, label: string, color: string) => {
      const c = stats.createEl("div", { cls: "pn-stat-card" });
      c.createEl("div", { text: String(num), cls: "pn-stat-num", attr: { style: `color:${color}` } });
      c.createEl("div", { text: label, cls: "pn-stat-label" });
    };
    addStat(plan.toPullNotes.length + plan.toPullAssets.length, "To Pull", "#38bdf8");
    addStat(plan.newLocalNotes.length, "New Local", "#4ade80");
    addStat(plan.modifiedLocalNotes.length, "Modified", "#fbbf24");
    addStat(plan.conflicts.length, "Conflicts", "#f87171");
    addStat(plan.remoteDeletes.length, "Remove", "#fb7185");
    addStat(plan.unchangedCount, "Synced", "#94a3b8");

    // 1. Conflicting Files Section
    if (plan.conflicts.length > 0) {
      const box = mainPane.createEl("div", { cls: "pn-section-box pn-conflict-box" });
      box.createEl("div", {
        text: `⚠️ Conflicting Files (${plan.conflicts.length}) — Changed both locally and on server`,
        cls: "pn-section-title",
      });
      const list = box.createEl("div", { cls: "pn-file-list" });
      for (const c of plan.conflicts) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: c.vaultPath });
        const btns = row.createEl("div", { attr: { style: "display:flex;gap:4px;" } });

        const bDiff = btns.createEl("button", { text: "Diff", attr: { style: "background:#2563eb;color:#fff;" } });
        bDiff.addEventListener("click", async () => {
          bDiff.disabled = true;
          bDiff.textContent = "Loading...";
          try {
            const serverText = await this.engine.fetchServerText(c.repoPath);
            this.showDiffModal(c.vaultPath, serverText, c.compiled.content);
          } catch (err: any) {
            new Notice(`Could not load diff: ${err.message}`);
          } finally {
            bDiff.disabled = false;
            bDiff.textContent = "Diff";
          }
        });

        const bServer = btns.createEl("button", { text: "Server", attr: { style: "background:#7c3aed;color:#fff;" } });
        bServer.addEventListener("click", async () => {
          if (!(await confirmVault(this.app, this.settings, `replacing "${c.vaultPath}" with the server version`))) return;
          await this.engine.resolveConflictKeepServer(c, plan);
          new Notice(`Updated ${c.vaultPath} from server`);
          await this.render();
        });

        const bLocal = btns.createEl("button", { text: "Local", attr: { style: "background:#047857;color:#fff;" } });
        bLocal.addEventListener("click", async () => {
          if (!(await confirmVault(this.app, this.settings, `replacing the server version of "${c.vaultPath}" with this vault's version`))) return;
          bLocal.disabled = true;
          try {
            await this.engine.resolveConflictKeepLocal(c);
            new Notice(`Published local version of ${c.vaultPath}`);
            if (this.onSyncComplete) this.onSyncComplete();
            await this.render();
          } catch (err: any) {
            new Notice(`Could not publish local version: ${err.message}`);
            bLocal.disabled = false;
          }
        });

        const bCopy = btns.createEl("button", { text: "Both", attr: { style: "background:#b45309;color:#fff;" } });
        bCopy.addEventListener("click", async () => {
          if (!(await confirmVault(this.app, this.settings, `resolving the conflict for "${c.vaultPath}"`))) return;
          bCopy.disabled = true;
          try {
            const copyPath = await this.engine.resolveConflictSaveCopy(c);
            new Notice(`Saved local backup at ${copyPath}; kept server version at original path`);
            await this.render();
          } catch (err: any) {
            new Notice(`Could not keep both versions: ${err.message}`);
            bCopy.disabled = false;
          }
        });
      }
    }

    // 2. Ready to Publish Section
    const pushNotes = [...plan.newLocalNotes, ...plan.modifiedLocalNotes];
    const lintWarnings = this.engine.lintNotes(pushNotes);
    if (lintWarnings.length > 0) {
      const warnBox = mainPane.createEl("div", { cls: "pn-section-box pn-conflict-box" });
      warnBox.createEl("div", {
        text: `⚠️ Pre-Publish Lint Warnings (${lintWarnings.length})`,
        cls: "pn-section-title",
      });
      const wList = warnBox.createEl("div", { cls: "pn-file-list" });
      for (const w of lintWarnings.slice(0, 15)) {
        wList.createEl("div", { text: w, cls: "pn-file-row" });
      }
    }

    const hasPendingPublish = pushNotes.length > 0 || plan.imagesToUpload.length > 0 || plan.remoteDeletes.length > 0;
    if (hasPendingPublish) {
      const box = mainPane.createEl("div", { cls: "pn-section-box" });
      box.createEl("div", {
        text: `Ready to Publish (${pushNotes.length} notes, ${plan.imagesToUpload.length} images, ${plan.remoteDeletes.length} remove)`,
        cls: "pn-section-title",
      });
      const list = box.createEl("div", { cls: "pn-file-list" });
      for (const n of plan.newLocalNotes) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: `🟢 NEW: ${n.file.path}` });
      }
      for (const n of plan.modifiedLocalNotes) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        const link = row.createEl("span", {
          text: `🟡 EDIT: ${n.file.path}`,
          attr: { style: "cursor:pointer;text-decoration:underline;text-underline-offset:3px;" },
        });
        const diffBtn = row.createEl("button", {
          text: "Diff",
          attr: { style: "font-size:11px;padding:2px 8px;" },
        });
        const openDiff = async () => {
          diffBtn.disabled = true;
          diffBtn.textContent = "...";
          try {
            const serverText = await this.engine.fetchServerText(n.repoPath);
            this.showDiffModal(n.file.path, serverText, n.content);
          } catch (err: any) {
            new Notice(`Could not load diff: ${err.message}`);
          } finally {
            diffBtn.disabled = false;
            diffBtn.textContent = "Diff";
          }
        };
        link.addEventListener("click", openDiff);
        diffBtn.addEventListener("click", openDiff);
      }
      for (const img of plan.imagesToUpload) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: `🖼 IMG: ${img.file.name}` });
      }
      for (const delPath of plan.remoteDeletes) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: `🔴 REMOVE: ${delPath}`, attr: { style: "color:#fb7185;" } });
      }
    }

    const pullTotal = plan.toPullNotes.length + plan.toPullAssets.length;
    if (pullTotal > 0) {
      const pullBox = mainPane.createEl("div", { cls: "pn-section-box" });
      pullBox.createEl("div", {
        text: `🔵 Updates on Server to Pull (${plan.toPullNotes.length} notes, ${plan.toPullAssets.length} images)`,
        cls: "pn-section-title",
      });
      const pullList = pullBox.createEl("div", { cls: "pn-file-list" });
      for (const n of plan.toPullNotes.slice(0, 40)) {
        pullList.createEl("div", { text: `📄 ${n.path}`, cls: "pn-file-row" });
      }
      for (const a of plan.toPullAssets.slice(0, 40)) {
        pullList.createEl("div", { text: `🖼 ${a.path}`, cls: "pn-file-row" });
      }
      if (pullTotal > 80) {
        pullList.createEl("div", { text: `...and ${pullTotal - 80} more file(s)` });
      }

      const pullRow = pullBox.createEl("div", { cls: "pn-main-publish-row" });
      const pullUpdatesBtn = pullRow.createEl("button", {
        text: `⬇️ Pull ${pullTotal} Update${pullTotal === 1 ? "" : "s"}`,
        cls: "mod-cta",
      });
      pullUpdatesBtn.addEventListener("click", async () => {
        const filesToPull = [
          ...plan.toPullNotes.map((f) => ({ path: f.path, type: "note" as const })),
          ...plan.toPullAssets.map((f) => ({ path: f.path, type: "asset" as const })),
        ];
        const confirmed = await confirmPullFiles(
          this.app,
          this.settings,
          `Pull ${pullTotal} Update${pullTotal === 1 ? "" : "s"} from Server`,
          filesToPull
        );
        if (!confirmed) return;
        pullUpdatesBtn.disabled = true;
        pullUpdatesBtn.textContent = "Pulling Updates...";
        progressWrap.style.display = "block";
        try {
          const count = await this.engine.pullFromServer(plan, (done, total) => {
            progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
          });
          new Notice(`✅ Pulled ${count} updated file(s) from PediaNotes`);
          if (this.onSyncComplete) this.onSyncComplete();
          await this.render();
        } catch (err: any) {
          new Notice(`❌ Pull failed: ${err.message}`);
          pullUpdatesBtn.disabled = false;
          pullUpdatesBtn.textContent = `⬇️ Pull ${pullTotal} Update${pullTotal === 1 ? "" : "s"}`;
        }
      });
    }

    if (!hasPendingPublish && pullTotal === 0 && plan.conflicts.length === 0) {
      mainPane.createEl("p", {
        text: "✨ Everything is up to date between your Obsidian vault and PediaNotes!",
      });
    }

    const progressWrap = mainPane.createEl("div", { cls: "pn-progress-wrap", attr: { style: "display:none;" } });
    const progressBar = progressWrap.createEl("div", { cls: "pn-progress-bar" });

    // Publish controls in Main Pane
    let commitInput: HTMLInputElement | null = null;
    if (hasPendingPublish) {
      const msgWrap = mainPane.createEl("div", { attr: { style: "margin-top:10px;" } });
      commitInput = msgWrap.createEl("input", {
        type: "text",
        placeholder: "Optional note about what you updated (saved in revision history)...",
        attr: { style: "width:100%;" },
      });

      const publishRow = mainPane.createEl("div", { cls: "pn-main-publish-row" });
      let ignorePullCb: HTMLInputElement | null = null;
      if (pullTotal > 0) {
        const ignoreWrap = publishRow.createEl("label", {
          attr: { style: "display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#fbbf24;cursor:pointer;margin-right:auto;" },
        });
        ignorePullCb = ignoreWrap.createEl("input", { type: "checkbox" });
        ignoreWrap.createSpan({
          text: `Ignore pending pull (${pullTotal} update${pullTotal === 1 ? "" : "s"}) and publish anyway`,
        });
      }

      const pushBtn = publishRow.createEl("button", {
        text: `🚀 Publish (${pushNotes.length} + ${plan.remoteDeletes.length} remove)`,
        cls: "mod-cta",
      });
      if (ignorePullCb) {
        pushBtn.disabled = true;
        ignorePullCb.addEventListener("change", () => {
          pushBtn.disabled = !ignorePullCb!.checked;
        });
      }
      pushBtn.addEventListener("click", async () => {
        if (!(await confirmVault(this.app, this.settings, "publishing vault changes"))) return;
        pushBtn.disabled = true;
        pushBtn.textContent = "Publishing & Rebuilding...";
        progressWrap.style.display = "block";
        progressBar.style.width = "5%";
        try {
          const res = await this.engine.pushToServer(pushNotes, plan.imagesToUpload, {
            deletes: plan.remoteDeletes,
            commitMessage: commitInput?.value.trim() || undefined,
            onProgress: (done, total) => {
              progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
            },
          });
          new Notice(
            `✅ Synced! Uploaded ${res.uploadedCount}, removed ${res.deletedCount}. Rebuilt in ${res.build?.ms || 0}ms.`
          );
          if (this.onSyncComplete) this.onSyncComplete();
          await this.render();
        } catch (err: any) {
          new Notice(`❌ Publish failed: ${err.message}`);
          pushBtn.disabled = false;
          pushBtn.textContent = `🚀 Publish (${pushNotes.length} + ${plan.remoteDeletes.length} remove)`;
        }
      });
    }

    // === RIGHT SIDE PANE ===
    sidePane.createEl("div", { text: "Actions", cls: "pn-side-pane-title" });
    const sideActions = sidePane.createEl("div", { cls: "pn-side-actions" });

    // 1. Pull all from server
    const pullAll = createActionButton(sideActions, "download", "Pull all from server");
    pullAll.button.addEventListener("click", async () => {
      pullAll.button.disabled = true;
      pullAll.setLabel("Checking server files...");
      try {
        const serverFiles = await this.engine.getServerManifestFiles();
        if (serverFiles.length === 0) {
          new Notice("✨ No files found on the PediaNotes server.");
          return;
        }
        const confirmed = await confirmPullFiles(
          this.app,
          this.settings,
          "Pull All Files from Server",
          serverFiles
        );
        if (!confirmed) return;
        pullAll.setLabel("Pulling all...");
        progressWrap.style.display = "block";
        const count = await this.engine.pullAllFromServer((done, total) => {
          progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
        });
        new Notice(`✅ Pulled ${count} total file(s) from PediaNotes`);
        if (this.onSyncComplete) this.onSyncComplete();
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Pull All failed: ${err.message}`);
      } finally {
        pullAll.button.disabled = false;
        pullAll.setLabel("Pull all from server");
      }
    });

    // 2. Rebuild vault to server state (regular action with strong warning)
    const rebuildBtn = createActionButton(sideActions, "rotate-ccw", "Rebuild vault to server state");
    rebuildBtn.button.addEventListener("click", async () => {
      const ok = await confirmActionModal(
        this.app,
        "Rebuild Vault to Server State",
        `WARNING: This will update your Vault Kit (plugins & CSS), overwrite local notes/images with the server versions, and DELETE (move to .trash) any local notes and images in "${vaultName}" that do not exist on the server. Any unpublished local work will be trashed. Continue?`,
        "Yes, Rebuild Vault"
      );
      if (!ok) return;
      rebuildBtn.button.disabled = true;
      rebuildBtn.setLabel("Rebuilding vault...");
      progressWrap.style.display = "block";
      try {
        const client = this.engine.getClient();
        const kit = await client.getVaultKit().catch(() => null);
        if (kit?.files?.length) {
          await installVaultKit(this.app, kit);
          this.settings.installedKitVersion = kit.version;
          await this.plugin.saveSettings();
        }
        const res = await this.engine.rebuildVaultToServerState((done, total) => {
          progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
        });
        new Notice(
          `✅ Vault rebuilt: pulled ${res.pulledCount} file(s), trashed ${res.deletedNotes} extra note(s) and ${res.deletedImages} extra image(s).`
        );
        if (this.onSyncComplete) this.onSyncComplete();
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Rebuild failed: ${err.message}`);
      } finally {
        rebuildBtn.button.disabled = false;
        rebuildBtn.setLabel("Rebuild vault to server state");
      }
    });

    // 3. Check / Update Syncer plugin itself
    const selfUpdateLabel = `Update Syncer (v${this.plugin.manifest.version})`;
    const selfUpdate = createActionButton(sideActions, "refresh-cw", selfUpdateLabel);
    selfUpdate.button.addEventListener("click", async () => {
      selfUpdate.button.disabled = true;
      selfUpdate.setLabel("Checking for updates...");
      try {
        const rel = await checkLatestPluginRelease(this.engine.getClient(), this.plugin.manifest.version);
        if (!rel) {
          new Notice(`✅ PediaNotes Sync is already up to date (v${this.plugin.manifest.version}).`);
          return;
        }
        selfUpdate.setLabel(`Updating to v${rel.version}...`);
        await updateSelfAndReload(this.app, this.plugin, rel);
        new Notice(`✅ Updated PediaNotes Sync to v${rel.version}!`);
      } catch (err: any) {
        new Notice(`❌ Syncer update failed: ${err.message}`);
      } finally {
        selfUpdate.button.disabled = false;
        selfUpdate.setLabel(selfUpdateLabel);
      }
    });

    // 4. Update Vault Kit
    const updateKit = createActionButton(sideActions, "palette", "Update Vault Kit");
    updateKit.button.addEventListener("click", async () => {
      updateKit.button.disabled = true;
      updateKit.setLabel("Updating Vault Kit...");
      try {
        const kit = await this.engine.getClient().getVaultKit();
        if (!kit.files || kit.files.length === 0) {
          new Notice("No Vault Kit has been uploaded for this site yet.");
          return;
        }
        const count = await installVaultKit(this.app, kit);
        this.settings.installedKitVersion = kit.version;
        await this.plugin.saveSettings();
        new Notice(`✅ Installed ${count} Vault Kit file(s) (version ${kit.version}). Reload Obsidian if new plugins were added.`);
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Vault Kit update failed: ${err.message}`);
      } finally {
        updateKit.button.disabled = false;
        updateKit.setLabel("Update Vault Kit");
      }
    });

    // 5. Delete unused images (save space) — regular action
    const removeUnused = createActionButton(sideActions, "trash-2", "Delete unused images (save space)");
    removeUnused.button.addEventListener("click", async () => {
      removeUnused.button.disabled = true;
      removeUnused.setLabel("Scanning images...");
      try {
        const scan = await findUnusedImages(this.app.vault);
        if (scan.unused.length === 0) {
          new Notice(`✨ No unused images found (${scan.totalImages} images scanned).`);
          return;
        }
        const mb = (scan.unusedBytes / (1024 * 1024)).toFixed(2);
        const ok = await confirmActionModal(
          this.app,
          "Delete Unused Images (Save Space)",
          `Found ${scan.unused.length} unused image(s) (${mb} MB) out of ${scan.totalImages} total images in "${vaultName}". Move them to Obsidian's .trash?`,
          `Yes, Move ${scan.unused.length} to Trash`
        );
        if (!ok) return;
        const removed = await removeUnusedImages(this.app.vault, scan.unused);
        new Notice(`✅ Moved ${removed} unused image(s) (${mb} MB) to .trash.`);
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Failed to delete unused images: ${err.message}`);
      } finally {
        removeUnused.button.disabled = false;
        removeUnused.setLabel("Delete unused images (save space)");
      }
    });

    // 6. View site
    const viewSite = createActionButton(sideActions, "globe", "View site");
    viewSite.button.addEventListener("click", () => {
      window.open(MODULE_URLS[this.settings.module], "_blank");
    });

    // === ADMIN-ONLY ACTIONS (Strictly hidden for non-admins) ===
    if (plan.isAdmin) {
      const adminWrap = sidePane.createEl("div", { cls: "pn-admin-section" });
      adminWrap.createEl("div", { text: "Admin Actions", cls: "pn-side-pane-title pn-admin-title" });
      const adminActions = adminWrap.createEl("div", { cls: "pn-side-actions" });

      // a. Treat vault as canonical (po and theory)
      if (this.settings.module === "po" || this.settings.module === "theory") {
        const canonical = createActionButton(adminActions, "upload-cloud", "Treat vault as canonical");
        canonical.button.addEventListener("click", async () => {
          if (!(await confirmVault(this.app, this.settings, "replacing server notes from this vault"))) return;
          if (!(await confirmCanonicalReplacement(this.app))) return;
          canonical.button.disabled = true;
          canonical.setLabel("Creating backup & replacing...");
          try {
            const result = await this.engine.replaceCanonicalNotes();
            if (!result.refreshed || !result.build?.ok) {
              new Notice(`GitHub updated; server refresh/build needs attention. Backup: ${result.backupBranch}`, 15000);
            } else {
              new Notice(`Canonical replacement complete. Backup: ${result.backupBranch}`, 15000);
            }
            if (this.onSyncComplete) this.onSyncComplete();
            await this.render();
          } catch (err: any) {
            new Notice(`Canonical replacement failed: ${err.message}`, 15000);
            canonical.button.disabled = false;
            canonical.setLabel("Treat vault as canonical");
          }
        });
      }

      // b. Convert all images to WebP (local vault)
      const webp = createActionButton(adminActions, "image", "Convert images to WebP");
      webp.button.addEventListener("click", async () => {
        const ok = await confirmActionModal(
          this.app,
          "Convert All Images to WebP",
          `This will deduplicate identical images, convert PNG/JPG/BMP images in "${vaultName}" to WebP, update Markdown image links, and move replaced originals to .trash. Continue?`,
          "Yes, Convert to WebP"
        );
        if (!ok) return;
        webp.button.disabled = true;
        webp.setLabel("Converting to WebP...");
        progressWrap.style.display = "block";
        try {
          const res = await convertAllImagesToWebP(this.app.vault, this.app.metadataCache, (done, total) => {
            progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
          });
          const savedMb = (res.savedBytes / (1024 * 1024)).toFixed(2);
          new Notice(
            `✅ WebP complete: converted ${res.converted}, deduplicated ${res.deduplicated}, updated ${res.linksUpdated} links across ${res.filesUpdated} notes (saved ~${savedMb} MB).`
          );
          await this.render();
        } catch (err: any) {
          new Notice(`❌ WebP conversion failed: ${err.message}`);
        } finally {
          webp.button.disabled = false;
          webp.setLabel("Convert images to WebP");
        }
      });

      // d. Server cleanup (unused images on main branch, dryRun first)
      const serverCleanup = createActionButton(adminActions, "sparkles", "Server cleanup (unused images)");
      serverCleanup.button.addEventListener("click", async () => {
        serverCleanup.button.disabled = true;
        serverCleanup.setLabel("Scanning server images...");
        try {
          const client = this.engine.getClient();
          const dry = await client.cleanupServerImages(true);
          const count = dry.unusedCount || 0;
          if (count === 0) {
            new Notice(`✨ No unused images on server (${dry.totalImages} checked).`);
            return;
          }
          const mb = (dry.totalBytes / (1024 * 1024)).toFixed(2);
          const ok = await confirmActionModal(
            this.app,
            "Server Cleanup: Remove Unused Images",
            `Dry run found ${count} unused image(s) (${mb} MB) out of ${dry.totalImages} images on the server's main branch. Remove them from GitHub and rebuild the site?`,
            `Yes, Remove ${count} Image(s)`
          );
          if (!ok) return;
          serverCleanup.setLabel("Removing from server...");
          const res = await client.cleanupServerImages(false);
          new Notice(`✅ Removed ${res.removedCount || count} unused image(s) (${mb} MB) from server.`);
          await this.render();
        } catch (err: any) {
          new Notice(`❌ Server cleanup failed: ${err.message}`);
        } finally {
          serverCleanup.button.disabled = false;
          serverCleanup.setLabel("Server cleanup (unused images)");
        }
      });

      // e. Upload Vault Kit
      const uploadKit = createActionButton(adminActions, "package", "Upload Vault Kit");
      uploadKit.button.addEventListener("click", () => {
        new AdminUploadKitModal(this.app, this.engine.getClient(), async (version) => {
          this.settings.installedKitVersion = version;
          await this.plugin.saveSettings();
          await this.render();
        }).open();
      });
    }
  }

  private async populateUpdateBanner(bannerEl: HTMLElement) {
    try {
      const client = this.engine.getClient();
      const [rel, kitMeta] = await Promise.all([
        checkLatestPluginRelease(client, this.plugin.manifest.version),
        client.getVaultKitMeta().catch(() => null),
      ]);

      const hasPluginUpdate = Boolean(rel);
      const hasKitUpdate = Boolean(
        kitMeta?.version && kitMeta.count > 0 && kitMeta.version !== this.settings.installedKitVersion
      );
      if (!hasPluginUpdate && !hasKitUpdate) return;

      bannerEl.empty();
      bannerEl.style.display = "flex";
      const textWrap = bannerEl.createEl("div");
      const parts: string[] = [];
      if (rel) parts.push(`Syncer v${rel.version} available (current v${this.plugin.manifest.version})`);
      if (hasKitUpdate && kitMeta) parts.push(`New Vault Kit (${kitMeta.count} plugin/CSS files)`);
      textWrap.createEl("strong", { text: `🔔 Updates available: ${parts.join(" • ")}` });

      const btnWrap = bannerEl.createEl("div", { attr: { style: "display:flex;gap:8px;flex-wrap:wrap;" } });
      if (rel) {
        const upBtn = btnWrap.createEl("button", { text: `⬆️ Update Syncer to v${rel.version}`, cls: "mod-cta" });
        upBtn.addEventListener("click", async () => {
          upBtn.disabled = true;
          upBtn.textContent = "Updating Syncer...";
          try {
            await updateSelfAndReload(this.app, this.plugin, rel);
            new Notice(`✅ Updated PediaNotes Sync to v${rel.version}!`);
          } catch (err: any) {
            new Notice(`❌ Self-update failed: ${err.message}`);
            upBtn.disabled = false;
            upBtn.textContent = `⬆️ Update Syncer to v${rel.version}`;
          }
        });
      }
      if (hasKitUpdate) {
        const kitBtn = btnWrap.createEl("button", { text: "🎨 Update Vault Kit (CSS & Plugins)" });
        kitBtn.addEventListener("click", async () => {
          kitBtn.disabled = true;
          kitBtn.textContent = "Installing Vault Kit...";
          try {
            const kit = await client.getVaultKit();
            const count = await installVaultKit(this.app, kit);
            this.settings.installedKitVersion = kit.version;
            await this.plugin.saveSettings();
            new Notice(`✅ Updated ${count} Vault Kit file(s).`);
            await this.render();
          } catch (err: any) {
            new Notice(`❌ Vault Kit update failed: ${err.message}`);
            kitBtn.disabled = false;
            kitBtn.textContent = "🎨 Update Vault Kit (CSS & Plugins)";
          }
        });
      }
    } catch {
      // Non-fatal
    }
  }

  private async renderSetupWizard(container: HTMLElement, vaultName: string) {
    const wizard = container.createEl("div", { cls: "pn-wizard" });
    wizard.createEl("h3", { text: "First-Time Vault Setup" });

    // Step 1: Login
    const step1 = wizard.createEl("div", { cls: "pn-wizard-step" });
    step1.createEl("div", {
      text: this.settings.token
        ? `✅ Step 1: Signed in as ${this.settings.userEmail || "PediaNotes Collaborator"}`
        : "Step 1: Sign in with PediaNotes",
      cls: "pn-wizard-step-title",
    });
    if (!this.settings.token) {
      step1.createEl("p", { text: "Authenticate with your PediaNotes collaborator or admin account." });
      const loginBtn = step1.createEl("button", { text: "Sign In with PediaNotes", cls: "mod-cta" });
      loginBtn.addEventListener("click", () => {
        window.open(`${AUTH_PORTAL_URL}/plugin-auth`, "_blank");
      });
    }

    // Step 2: Select Theory / Practical
    const step2 = wizard.createEl("div", { cls: "pn-wizard-step" });
    step2.createEl("div", {
      text: "Step 2: Select PediaNotes Site (Theory / Practical & OSCE)",
      cls: "pn-wizard-step-title",
    });
    const dd = step2.createEl("select", { attr: { style: "min-width:280px;margin-top:6px;" } });
    dd.createEl("option", { text: "Select a site…", value: "unselected" });
    dd.createEl("option", { text: "DNB Theory (theory.pedianotes.in)", value: "theory" });
    dd.createEl("option", { text: "Practical & OSCE (practical2.pedianotes.in)", value: "po" });
    dd.value = this.settings.module;
    dd.addEventListener("change", async () => {
      this.settings.module = dd.value as PediaModule;
      await this.plugin.saveSettings();
      await this.render();
    });

    // Step 3: Setup Vault
    const step3 = wizard.createEl("div", { cls: "pn-wizard-step" });
    step3.createEl("div", { text: "Step 3: Setup Vault", cls: "pn-wizard-step-title" });
    step3.createEl("p", {
      text: `Installs required plugins, CSS snippets, and theme into "${vaultName}", updates the syncer plugin if needed, and pulls notes from the server.`,
    });

    const canSetup = Boolean(this.settings.token && MODULE_URLS[this.settings.module]);
    const setupBtn = step3.createEl("button", { text: "🚀 Setup Vault", cls: "mod-cta" });
    setupBtn.disabled = !canSetup;
    const statusEl = step3.createEl("p", { attr: { style: "font-size:12px;color:var(--text-muted);margin-top:8px;" } });

    setupBtn.addEventListener("click", async () => {
      setupBtn.disabled = true;
      try {
        const client = this.engine.getClient();
        statusEl.setText("Checking for latest syncer plugin...");
        const rel = await checkLatestPluginRelease(client, this.plugin.manifest.version);
        if (rel) {
          statusEl.setText(`Updating syncer to v${rel.version}...`);
          await updateSelfAndReload(this.app, this.plugin, rel);
        }

        statusEl.setText("Downloading and installing Vault Kit (plugins & CSS)...");
        const kit = await client.getVaultKit().catch(() => null);
        if (kit?.files?.length) {
          const count = await installVaultKit(this.app, kit);
          this.settings.installedKitVersion = kit.version;
          new Notice(`✅ Installed ${count} Vault Kit file(s).`);
        }

        statusEl.setText("Checking notes & images to pull...");
        const serverFiles = await this.engine.getServerManifestFiles();
        if (serverFiles.length > 0) {
          const confirmed = await confirmPullFiles(
            this.app,
            this.settings,
            "Pull Notes & Images for Initial Setup",
            serverFiles
          );
          if (confirmed) {
            statusEl.setText(`Pulling ${serverFiles.length} file(s)...`);
            await this.engine.pullAllFromServer((done, total) => {
              statusEl.setText(`Pulling ${done}/${total} file(s)...`);
            });
          }
        }

        this.settings.vaultSetupCompleted = true;
        await this.plugin.saveSettings();
        new Notice(`✅ Vault "${vaultName}" setup complete!`);
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Vault setup failed: ${err.message}`);
        statusEl.setText(`❌ ${err.message}`);
        setupBtn.disabled = false;
      }
    });

    if (this.settings.token && MODULE_URLS[this.settings.module]) {
      const skipBtn = step3.createEl("button", {
        text: "Skip Wizard & Open Sync Center",
        attr: { style: "margin-left:8px;" },
      });
      skipBtn.addEventListener("click", async () => {
        this.settings.vaultSetupCompleted = true;
        await this.plugin.saveSettings();
        await this.render();
      });
    }
  }

  private showDiffModal(title: string, serverText: string, localText: string) {
    const m = new Modal(this.app);
    m.contentEl.createEl("h3", { text: `GitHub-Style Diff: ${title}` });
    m.contentEl.createEl("p", {
      text: "Red (-) = Server version | Green (+) = Your local version",
      attr: { style: "font-size:12px;color:var(--text-muted);" },
    });

    const box = m.contentEl.createEl("pre", {
      attr: {
        style:
          "max-height:420px;overflow:auto;padding:12px;border-radius:8px;background:var(--background-secondary);font-size:12px;line-height:1.5;white-space:pre-wrap;",
      },
    });

    const sLines = serverText.split("\n");
    const lLines = localText.split("\n");
    const maxLen = Math.max(sLines.length, lLines.length);

    for (let i = 0; i < maxLen; i++) {
      const s = sLines[i];
      const l = lLines[i];
      if (s === l) {
        if (s !== undefined) {
          box.createEl("div", { text: `  ${s}`, attr: { style: "color:var(--text-muted);" } });
        }
      } else {
        if (s !== undefined) {
          box.createEl("div", {
            text: `- ${s}`,
            attr: { style: "background:rgba(244,63,94,0.16);color:#fda4af;" },
          });
        }
        if (l !== undefined) {
          box.createEl("div", {
            text: `+ ${l}`,
            attr: { style: "background:rgba(16,185,129,0.16);color:#6ee7b7;" },
          });
        }
      }
    }
    m.open();
  }
}

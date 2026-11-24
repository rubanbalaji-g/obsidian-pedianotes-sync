import { App, ItemView, Modal, Notice, WorkspaceLeaf } from "obsidian";
import { AUTH_PORTAL_URL, MODULE_URLS, PediaModule, PediaNotesPluginSettings } from "src/models/settings";
import { SyncEngine, SyncPlan } from "src/sync/SyncEngine";
import { confirmCanonicalReplacement, confirmVault } from "src/utils/confirmVault";
import { confirmPullFiles } from "src/utils/confirmPull";
import { convertAllImagesToWebP, findUnusedImages, removeUnusedImages } from "src/utils/vaultImages";

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

export class SyncView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
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

    if (!MODULE_URLS[this.settings.module]) {
      container.createEl("p", {
        text: "The separate Practical and OSCE sites have been retired. Open PediaNotes plugin settings and select Theory or the combined P&O site for this vault before syncing.",
      });
      return;
    }

    if (!this.settings.token) {
      container.createEl("p", {
        text: "Sign in with your PediaNotes account to sync notes and images.",
      });
      const btn = container.createEl("button", {
        text: "Sign In with PediaNotes",
        cls: "mod-cta",
      });
      btn.addEventListener("click", () => {
        window.open(`${AUTH_PORTAL_URL}/plugin-auth`, "_blank");
      });
      return;
    }

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
      const pushBtn = publishRow.createEl("button", {
        text: `🚀 Publish (${pushNotes.length} + ${plan.remoteDeletes.length} remove)`,
        cls: "mod-cta",
      });
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

    // a. Treat vault as canonical (shown on both po and theory for admins)
    if (plan.isAdmin && (this.settings.module === "po" || this.settings.module === "theory")) {
      const canonicalBtn = sideActions.createEl("button", { text: "Treat vault as canonical" });
      canonicalBtn.addEventListener("click", async () => {
        if (!(await confirmVault(this.app, this.settings, "replacing server notes from this vault"))) return;
        if (!(await confirmCanonicalReplacement(this.app))) return;
        canonicalBtn.disabled = true;
        canonicalBtn.textContent = "Creating backup & replacing...";
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
          canonicalBtn.disabled = false;
          canonicalBtn.textContent = "Treat vault as canonical";
        }
      });
    }

    // b. Pull all from server (single consolidated pull button)
    const pullAllLabel = pullTotal > 0 ? `⬇️ Pull all from server (${pullTotal} updates)` : "⬇️ Pull all from server";
    const pullAllBtn = sideActions.createEl("button", { text: pullAllLabel });
    pullAllBtn.addEventListener("click", async () => {
      pullAllBtn.disabled = true;
      pullAllBtn.textContent = "Checking server files...";
      try {
        const serverFiles = await this.engine.getServerManifestFiles();
        if (serverFiles.length === 0) {
          new Notice("✨ No files found on the PediaNotes server.");
          pullAllBtn.disabled = false;
          pullAllBtn.textContent = pullAllLabel;
          return;
        }
        const confirmed = await confirmPullFiles(
          this.app,
          this.settings,
          "Pull All Files from Server",
          serverFiles
        );
        if (!confirmed) {
          pullAllBtn.disabled = false;
          pullAllBtn.textContent = pullAllLabel;
          return;
        }
        pullAllBtn.textContent = "Pulling All...";
        progressWrap.style.display = "block";
        const count = await this.engine.pullAllFromServer((done, total) => {
          progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
        });
        new Notice(`✅ Pulled ${count} total file(s) from PediaNotes`);
        if (this.onSyncComplete) this.onSyncComplete();
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Pull All failed: ${err.message}`);
        pullAllBtn.disabled = false;
        pullAllBtn.textContent = pullAllLabel;
      }
    });

    // c. Remove unused images
    const removeUnusedBtn = sideActions.createEl("button", { text: "🗑 Remove unused images" });
    removeUnusedBtn.addEventListener("click", async () => {
      removeUnusedBtn.disabled = true;
      removeUnusedBtn.textContent = "Scanning images...";
      try {
        const scan = await findUnusedImages(this.app.vault);
        if (scan.unused.length === 0) {
          new Notice(`✨ No unused images found (${scan.totalImages} images scanned).`);
          return;
        }
        const mb = (scan.unusedBytes / (1024 * 1024)).toFixed(2);
        const ok = await confirmActionModal(
          this.app,
          "Remove Unused Images",
          `Found ${scan.unused.length} unused image(s) (${mb} MB) out of ${scan.totalImages} total images in "${vaultName}". Move them to Obsidian's .trash?`,
          `Move ${scan.unused.length} to Trash`
        );
        if (!ok) return;
        const removed = await removeUnusedImages(this.app.vault, scan.unused);
        new Notice(`🗑 Moved ${removed} unused image(s) (${mb} MB) to .trash.`);
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Failed to remove unused images: ${err.message}`);
      } finally {
        removeUnusedBtn.disabled = false;
        removeUnusedBtn.textContent = "🗑 Remove unused images";
      }
    });

    // d. Convert all images to WebP
    const webpBtn = sideActions.createEl("button", { text: "🖼 Convert all images to WebP" });
    webpBtn.addEventListener("click", async () => {
      const ok = await confirmActionModal(
        this.app,
        "Convert All Images to WebP",
        `This will deduplicate identical images, convert PNG/JPG/BMP images in "${vaultName}" to WebP, update Markdown image links, and move replaced originals to .trash. Continue?`,
        "Convert to WebP"
      );
      if (!ok) return;
      webpBtn.disabled = true;
      webpBtn.textContent = "Converting to WebP...";
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
        webpBtn.disabled = false;
        webpBtn.textContent = "🖼 Convert all images to WebP";
      }
    });

    // e. View site
    const webBtn = sideActions.createEl("button", { text: "🌐 View site" });
    webBtn.addEventListener("click", () => {
      window.open(MODULE_URLS[this.settings.module], "_blank");
    });
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

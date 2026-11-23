import { App, Modal, Notice } from "obsidian";
import { AUTH_PORTAL_URL, MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";
import { ConflictItem, SyncEngine, SyncPlan } from "src/sync/SyncEngine";

export class SyncModal extends Modal {
  constructor(
    app: App,
    private engine: SyncEngine,
    private settings: PediaNotesPluginSettings,
    private onSyncComplete?: () => void
  ) {
    super(app);
  }

  async onOpen() {
    await this.render();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pn-sync-modal");

    const header = contentEl.createEl("div", { cls: "pn-sync-header" });
    header.createEl("h2", { text: "PediaNotes Syncer", attr: { style: "margin:0;" } });
    header.createEl("span", {
      text: `${this.settings.module.toUpperCase()} • ${this.settings.userEmail || "Not Signed In"}`,
      cls: "pn-sync-badge",
    });

    if (!this.settings.token) {
      contentEl.createEl("p", {
        text: "Sign in with your PediaNotes account to sync notes and images.",
      });
      const btn = contentEl.createEl("button", {
        text: "Sign In with PediaNotes",
        cls: "mod-cta",
      });
      btn.addEventListener("click", () => {
        window.open(`${AUTH_PORTAL_URL}/plugin-auth`, "_blank");
      });
      return;
    }

    const loadingEl = contentEl.createEl("p", { text: "Comparing local vault with PediaNotes server..." });

    let plan: SyncPlan;
    try {
      plan = await this.engine.computeSyncPlan();
      loadingEl.remove();
    } catch (err: any) {
      loadingEl.setText(`❌ Sync check failed: ${err.message}`);
      return;
    }

    // Stats Cards
    const stats = contentEl.createEl("div", { cls: "pn-sync-stats" });
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

    // 1. Conflicts Section
    if (plan.conflicts.length > 0) {
      const box = contentEl.createEl("div", { cls: "pn-section-box pn-conflict-box" });
      box.createEl("div", {
        text: `⚠️ Conflicts (${plan.conflicts.length}) — Changed both locally and on server`,
        cls: "pn-section-title",
      });
      const list = box.createEl("div", { cls: "pn-file-list" });
      for (const c of plan.conflicts) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: c.vaultPath });
        const btns = row.createEl("div", { attr: { style: "display:flex;gap:4px;" } });

        const bDiff = btns.createEl("button", { text: "View Diff" });
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
            bDiff.textContent = "View Diff";
          }
        });

        const bServer = btns.createEl("button", { text: "Keep Server" });
        bServer.addEventListener("click", async () => {
          await this.engine.resolveConflictKeepServer(c, plan);
          new Notice(`Updated ${c.vaultPath} from server`);
          await this.render();
        });

        const bCopy = btns.createEl("button", { text: "Save Copy" });
        bCopy.addEventListener("click", async () => {
          const copyPath = await this.engine.resolveConflictSaveCopy(c);
          new Notice(`Saved local copy at ${copyPath}`);
          await this.render();
        });
      }
    }

    // 2. Pull Updates Section
    const pullTotal = plan.toPullNotes.length + plan.toPullAssets.length;
    if (pullTotal > 0) {
      const box = contentEl.createEl("div", { cls: "pn-section-box" });
      box.createEl("div", {
        text: `🔵 Updates on Server to Pull (${plan.toPullNotes.length} notes, ${plan.toPullAssets.length} images)`,
        cls: "pn-section-title",
      });
      const list = box.createEl("div", { cls: "pn-file-list" });
      for (const n of plan.toPullNotes.slice(0, 40)) {
        list.createEl("div", { text: n.path, cls: "pn-file-row" });
      }
      if (plan.toPullNotes.length > 40) {
        list.createEl("div", { text: `...and ${plan.toPullNotes.length - 40} more notes` });
      }
    }

    // 3. Push Local Changes Section
    const pushNotes = [...plan.newLocalNotes, ...plan.modifiedLocalNotes];
    const lintWarnings = this.engine.lintNotes(pushNotes);
    if (lintWarnings.length > 0) {
      const warnBox = contentEl.createEl("div", { cls: "pn-section-box pn-conflict-box" });
      warnBox.createEl("div", {
        text: `⚠️ Pre-Publish Lint Warnings (${lintWarnings.length})`,
        cls: "pn-section-title",
      });
      const wList = warnBox.createEl("div", { cls: "pn-file-list" });
      for (const w of lintWarnings.slice(0, 15)) {
        wList.createEl("div", { text: w, cls: "pn-file-row" });
      }
    }

    if (pushNotes.length > 0 || plan.imagesToUpload.length > 0 || plan.remoteDeletes.length > 0) {
      const box = contentEl.createEl("div", { cls: "pn-section-box" });
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

    if (
      pullTotal === 0 &&
      pushNotes.length === 0 &&
      plan.imagesToUpload.length === 0 &&
      plan.remoteDeletes.length === 0 &&
      plan.conflicts.length === 0
    ) {
      contentEl.createEl("p", {
        text: "✨ Everything is up to date between your Obsidian vault and PediaNotes!",
      });
    }

    // Commit Note Input (if pushing)
    let commitInput: HTMLInputElement | null = null;
    if (pushNotes.length > 0 || plan.imagesToUpload.length > 0 || plan.remoteDeletes.length > 0) {
      const msgWrap = contentEl.createEl("div", { attr: { style: "margin-top:10px;" } });
      commitInput = msgWrap.createEl("input", {
        type: "text",
        placeholder: "Optional note about what you updated (saved in revision history)...",
        attr: { style: "width:100%;" },
      });
    }

    const progressWrap = contentEl.createEl("div", { cls: "pn-progress-wrap", attr: { style: "display:none;" } });
    const progressBar = progressWrap.createEl("div", { cls: "pn-progress-bar" });

    const actions = contentEl.createEl("div", { cls: "pn-actions-row" });

    if (plan.isAdmin && this.settings.module === "po") {
      const canonicalBtn = actions.createEl("button", { text: "Treat vault as canonical" });
      canonicalBtn.addEventListener("click", async () => {
        const confirmation = window.prompt(
          "ADMIN ACTION: This first creates a GitHub backup branch, then replaces ALL P&O clinical Markdown notes with vault notes marked publish: true. Existing server-only notes will be removed from main. Site layouts and assets are preserved. This cannot be undone automatically.\n\nType REPLACE to continue:"
        );
        if (confirmation !== "REPLACE") return;
        canonicalBtn.disabled = true;
        canonicalBtn.textContent = "Creating backup and replacing notes...";
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

    if (pullTotal > 0) {
      const pullBtn = actions.createEl("button", { text: `⬇️ Pull ${pullTotal} Updates` });
      pullBtn.addEventListener("click", async () => {
        pullBtn.disabled = true;
        progressWrap.style.display = "block";
        try {
          const count = await this.engine.pullFromServer(plan, (done, total) => {
            progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
          });
          new Notice(`✅ Pulled ${count} file(s) from PediaNotes`);
          if (this.onSyncComplete) this.onSyncComplete();
          await this.render();
        } catch (err: any) {
          new Notice(`❌ Pull error: ${err.message}`);
          pullBtn.disabled = false;
        }
      });
    }

    if (pushNotes.length > 0 || plan.imagesToUpload.length > 0 || plan.remoteDeletes.length > 0) {
      const pushBtn = actions.createEl("button", {
        text: `🚀 Publish (${pushNotes.length} + ${plan.remoteDeletes.length} remove)`,
        cls: "mod-cta",
      });
      pushBtn.addEventListener("click", async () => {
        pushBtn.disabled = true;
        pushBtn.textContent = "Publishing & Rebuilding...";
        progressWrap.style.display = "block";
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
          this.close();
        } catch (err: any) {
          new Notice(`❌ Publish failed: ${err.message}`);
          pushBtn.disabled = false;
          pushBtn.textContent = `🚀 Publish (${pushNotes.length} + ${plan.remoteDeletes.length} remove)`;
        }
      });
    }

    const webBtn = actions.createEl("button", { text: "Open Site" });
    webBtn.addEventListener("click", () => {
      window.open(MODULE_URLS[this.settings.module], "_blank");
    });

    const pullAllBtn = actions.createEl("button", { text: "⬇️ Pull All from Server" });
    pullAllBtn.addEventListener("click", async () => {
      pullAllBtn.disabled = true;
      pullAllBtn.textContent = "Pulling All...";
      progressWrap.style.display = "block";
      try {
        const count = await this.engine.pullAllFromServer((done, total) => {
          progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
        });
        new Notice(`✅ Pulled ${count} total file(s) from PediaNotes`);
        if (this.onSyncComplete) this.onSyncComplete();
        await this.render();
      } catch (err: any) {
        new Notice(`❌ Pull All failed: ${err.message}`);
        pullAllBtn.disabled = false;
        pullAllBtn.textContent = "⬇️ Pull All from Server";
      }
    });

    const closeBtn = actions.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  private showDiffModal(title: string, serverText: string, localText: string) {
    const m = new Modal(this.app);
    m.contentEl.createEl("h3", { text: `GitHub-Style Diff: ${title}` });
    m.contentEl.createEl("p", {
      text: "Red (-) = Server version | Green (+) = Your local version",
      attr: { style: "font-size:12px;color:var(--text-muted);margin-bottom:10px;" },
    });
    const pre = m.contentEl.createEl("div", {
      attr: {
        style:
          "max-height:460px;overflow:auto;background:#0d1117;border:1px solid rgba(255,255,255,0.12);border-radius:8px;font-family:var(--font-monospace);font-size:11.5px;line-height:1.5;",
      },
    });
    const sLines = serverText.replace(/\r\n/g, "\n").split("\n");
    const lLines = localText.replace(/\r\n/g, "\n").split("\n");
    const maxLen = Math.max(sLines.length, lLines.length);

    let hasDiff = false;
    for (let i = 0; i < maxLen; i++) {
      const s = sLines[i];
      const l = lLines[i];
      if (s === l) continue;
      hasDiff = true;
      if (s !== undefined) {
        const row = pre.createEl("div", {
          attr: { style: "display:flex;gap:10px;padding:2px 10px;background:rgba(248,81,73,0.15);color:#ffa198;" },
        });
        row.createEl("span", { text: String(i + 1).padStart(4, " "), attr: { style: "opacity:0.5;user-select:none;" } });
        row.createEl("span", { text: `- ${s}`, attr: { style: "white-space:pre-wrap;word-break:break-word;" } });
      }
      if (l !== undefined) {
        const row = pre.createEl("div", {
          attr: { style: "display:flex;gap:10px;padding:2px 10px;background:rgba(46,160,67,0.18);color:#7ee787;" },
        });
        row.createEl("span", { text: String(i + 1).padStart(4, " "), attr: { style: "opacity:0.5;user-select:none;" } });
        row.createEl("span", { text: `+ ${l}`, attr: { style: "white-space:pre-wrap;word-break:break-word;" } });
      }
    }

    if (!hasDiff) {
      pre.createEl("div", { text: "No differences found.", attr: { style: "padding:14px;color:#94a3b8;" } });
    }
    m.open();
  }

  onClose() {
    this.contentEl.empty();
  }
}

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
    header.createEl("h2", { text: "PediaNotes 2-Way Sync Center", attr: { style: "margin:0;" } });
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

    if (pushNotes.length > 0 || plan.imagesToUpload.length > 0) {
      const box = contentEl.createEl("div", { cls: "pn-section-box" });
      box.createEl("div", {
        text: `🟢/🟡 Ready to Publish (${pushNotes.length} notes, ${plan.imagesToUpload.length} images)`,
        cls: "pn-section-title",
      });
      const list = box.createEl("div", { cls: "pn-file-list" });
      for (const n of plan.newLocalNotes) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: `🟢 NEW: ${n.file.path}` });
      }
      for (const n of plan.modifiedLocalNotes) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: `🟡 EDIT: ${n.file.path}` });
      }
      for (const img of plan.imagesToUpload) {
        const row = list.createEl("div", { cls: "pn-file-row" });
        row.createEl("span", { text: `🖼 IMG: ${img.file.name}` });
      }
    }

    if (pullTotal === 0 && pushNotes.length === 0 && plan.imagesToUpload.length === 0 && plan.conflicts.length === 0) {
      contentEl.createEl("p", {
        text: "✨ Everything is up to date between your Obsidian vault and PediaNotes!",
      });
    }

    // Commit Note Input (if pushing)
    let commitInput: HTMLInputElement | null = null;
    if (pushNotes.length > 0 || plan.imagesToUpload.length > 0) {
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

    if (pushNotes.length > 0 || plan.imagesToUpload.length > 0) {
      const pushBtn = actions.createEl("button", {
        text: `🚀 Publish ${pushNotes.length} Note(s)`,
        cls: "mod-cta",
      });
      pushBtn.addEventListener("click", async () => {
        pushBtn.disabled = true;
        pushBtn.textContent = "Publishing & Rebuilding...";
        progressWrap.style.display = "block";
        try {
          const res = await this.engine.pushToServer(pushNotes, plan.imagesToUpload, {
            commitMessage: commitInput?.value.trim() || undefined,
            onProgress: (done, total) => {
              progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
            },
          });
          new Notice(
            `✅ Published ${res.uploadedCount} file(s)! Site rebuilt in ${res.build?.ms || 0}ms.`
          );
          if (this.onSyncComplete) this.onSyncComplete();
          this.close();
        } catch (err: any) {
          new Notice(`❌ Publish failed: ${err.message}`);
          pushBtn.disabled = false;
          pushBtn.textContent = `🚀 Publish ${pushNotes.length} Note(s)`;
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
    m.contentEl.createEl("h3", { text: `Diff: ${title}` });
    m.contentEl.createEl("p", {
      text: "Red (-) = Server version | Green (+) = Your local version",
      attr: { style: "font-size:12px;color:var(--text-muted);" },
    });
    const pre = m.contentEl.createEl("pre", {
      attr: {
        style:
          "max-height:420px;overflow:auto;background:var(--background-secondary);padding:12px;border-radius:8px;font-size:11.5px;white-space:pre-wrap;",
      },
    });
    const sLines = serverText.replace(/\r\n/g, "\n").split("\n");
    const lLines = localText.replace(/\r\n/g, "\n").split("\n");
    const sSet = new Set(sLines);
    const lSet = new Set(lLines);

    for (const line of sLines) {
      if (!lSet.has(line)) {
        pre.createEl("div", {
          text: `- ${line}`,
          attr: { style: "color:#f87171;background:rgba(239,68,68,0.1);" },
        });
      }
    }
    for (const line of lLines) {
      if (!sSet.has(line)) {
        pre.createEl("div", {
          text: `+ ${line}`,
          attr: { style: "color:#4ade80;background:rgba(74,222,128,0.1);" },
        });
      }
    }
    m.open();
  }

  onClose() {
    this.contentEl.empty();
  }
}

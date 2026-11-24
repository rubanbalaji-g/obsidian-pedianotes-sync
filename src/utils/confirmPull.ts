import { App, Modal } from "obsidian";
import { MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";

export interface PullPreviewFile {
  path: string;
  type: "note" | "asset";
}

export function confirmPullFiles(
  app: App,
  settings: PediaNotesPluginSettings,
  title: string,
  files: PullPreviewFile[]
): Promise<boolean> {
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

    const noteCount = files.filter((f) => f.type === "note").length;
    const assetCount = files.length - noteCount;

    modal.contentEl.createEl("h3", { text: title });
    modal.contentEl.createEl("p", {
      text: `Vault: ${app.vault.getName()}  •  Site: ${MODULE_URLS[settings.module] || "Unknown"}`,
      attr: { style: "font-size:12px;color:var(--text-muted);margin-bottom:8px;" },
    });
    modal.contentEl.createEl("p", {
      text: `The following ${files.length} file(s) (${noteCount} notes, ${assetCount} images) will be pulled from the server (existing local files at these paths will be overwritten):`,
    });

    const list = modal.contentEl.createEl("div", {
      attr: {
        style:
          "max-height:280px;overflow-y:auto;padding:8px 10px;border-radius:8px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);font-family:var(--font-monospace);font-size:12px;margin:10px 0;",
      },
    });
    for (const f of files) {
      const icon = f.type === "note" ? "📄" : "🖼";
      list.createEl("div", {
        text: `${icon} ${f.path}`,
        attr: { style: "padding:2px 0;border-bottom:1px solid var(--background-modifier-border);" },
      });
    }

    const row = modal.contentEl.createEl("div", {
      attr: { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;" },
    });
    const cancelBtn = row.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => finish(false));
    const okBtn = row.createEl("button", { text: `Confirm Pull (${files.length})`, cls: "mod-cta" });
    okBtn.addEventListener("click", () => finish(true));
    modal.open();
  });
}

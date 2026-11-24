import { App, Modal, Notice } from "obsidian";
import { Base64 } from "js-base64";
import { PediaNotesClient } from "src/api/PediaNotesClient";

export interface VaultKitFile {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
}

const TEXT_EXTS = new Set(["json", "css", "js", "mjs", "cjs", "txt", "md", "svg"]);

function isSafeKitPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("..") || p.includes("\0")) return false;
  if (p === "plugins/obsidian-pedianotes-sync/data.json") return false;
  if (p === "workspace.json" || p === "workspace-mobile.json") return false;
  const segs = p.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || s === ".git" || s === ".DS_Store")) return false;
  return (
    p === "appearance.json" ||
    p === "community-plugins.json" ||
    p === "app.json" ||
    p.startsWith("plugins/") ||
    p.startsWith("snippets/") ||
    p.startsWith("themes/")
  );
}

export async function installVaultKit(
  app: App,
  kit: { version: string; files: VaultKitFile[] }
): Promise<number> {
  const cfgDir = app.vault.configDir;
  let installed = 0;

  for (const item of kit.files || []) {
    if (!isSafeKitPath(item.path)) continue;
    const fullPath = `${cfgDir}/${item.path}`;
    const parent = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (parent) await app.vault.adapter.mkdir(parent).catch(() => {});

    if (item.encoding === "base64") {
      const bytes = Base64.toUint8Array(item.content);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await app.vault.adapter.writeBinary(fullPath, ab);
    } else {
      await app.vault.adapter.write(fullPath, item.content);
    }
    installed++;
  }

  // Ensure obsidian-pedianotes-sync stays enabled in community-plugins.json
  try {
    const cpPath = `${cfgDir}/community-plugins.json`;
    let list: string[] = [];
    if (await app.vault.adapter.exists(cpPath)) {
      list = JSON.parse(await app.vault.adapter.read(cpPath));
    }
    if (!Array.isArray(list)) list = [];
    if (!list.includes("obsidian-pedianotes-sync")) {
      list.push("obsidian-pedianotes-sync");
      await app.vault.adapter.write(cpPath, JSON.stringify(list, null, 2));
    }
  } catch {
    // Non-fatal
  }

  return installed;
}

async function listFilesRecursively(app: App, dir: string, out: string[] = []): Promise<string[]> {
  try {
    const res = await app.vault.adapter.list(dir);
    for (const f of res.files || []) out.push(f);
    for (const sub of res.folders || []) await listFilesRecursively(app, sub, out);
  } catch {
    // Directory may not exist
  }
  return out;
}

export class AdminUploadKitModal extends Modal {
  constructor(app: App, private client: PediaNotesClient, private onUploaded?: (version: string) => void) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Upload Vault Kit (Plugins, CSS & Theme)" });
    contentEl.createEl("p", {
      text: "Select which plugins, CSS snippets, and themes to package for collaborators. Your PediaNotes authentication token and sync state (data.json) are always excluded.",
      attr: { style: "font-size:12px;color:var(--text-muted);" },
    });

    const cfgDir = this.app.vault.configDir;
    const pluginsRes = await this.app.vault.adapter.list(`${cfgDir}/plugins`).catch(() => ({ folders: [], files: [] }));
    const snippetsRes = await this.app.vault.adapter.list(`${cfgDir}/snippets`).catch(() => ({ folders: [], files: [] }));
    const themesRes = await this.app.vault.adapter.list(`${cfgDir}/themes`).catch(() => ({ folders: [], files: [] }));

    const selectedPlugins = new Set<string>();
    const selectedSnippets = new Set<string>();
    const selectedThemes = new Set<string>();
    let includeAppearance = true;
    let includeCommunityPlugins = true;
    let excludeOtherPluginData = true;

    const listWrap = contentEl.createEl("div", {
      attr: { style: "max-height:340px;overflow-y:auto;padding:10px;border:1px solid var(--background-modifier-border);border-radius:8px;margin:10px 0;" },
    });

    const addCheck = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
      const row = listWrap.createEl("label", { attr: { style: "display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;" } });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = checked;
      cb.addEventListener("change", () => onChange(cb.checked));
      row.createSpan({ text: label });
    };

    listWrap.createEl("strong", { text: "Plugins" });
    for (const folder of pluginsRes.folders || []) {
      const name = folder.split("/").pop() || folder;
      if (name === "obsidian-pedianotes-sync" || name === "obsidian42-brat") continue;
      selectedPlugins.add(name);
      addCheck(`🔌 ${name}`, true, (v) => (v ? selectedPlugins.add(name) : selectedPlugins.delete(name)));
    }

    listWrap.createEl("strong", { text: "CSS Snippets", attr: { style: "display:block;margin-top:10px;" } });
    for (const file of snippetsRes.files || []) {
      const name = file.split("/").pop() || file;
      if (!name.endsWith(".css")) continue;
      selectedSnippets.add(name);
      addCheck(`🎨 ${name}`, true, (v) => (v ? selectedSnippets.add(name) : selectedSnippets.delete(name)));
    }

    if ((themesRes.folders || []).length > 0) {
      listWrap.createEl("strong", { text: "Themes", attr: { style: "display:block;margin-top:10px;" } });
      for (const folder of themesRes.folders || []) {
        const name = folder.split("/").pop() || folder;
        selectedThemes.add(name);
        addCheck(`🖌 ${name}`, true, (v) => (v ? selectedThemes.add(name) : selectedThemes.delete(name)));
      }
    }

    listWrap.createEl("strong", { text: "Vault Config & Privacy", attr: { style: "display:block;margin-top:10px;" } });
    addCheck("appearance.json (dark/light & enabled snippets)", true, (v) => (includeAppearance = v));
    addCheck("community-plugins.json (enabled plugin list)", true, (v) => (includeCommunityPlugins = v));
    addCheck("Exclude other plugins' data.json (recommended for privacy)", true, (v) => (excludeOtherPluginData = v));

    const statusEl = contentEl.createEl("p", { attr: { style: "font-size:12px;color:var(--text-muted);" } });
    const actions = contentEl.createEl("div", { attr: { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;" } });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const uploadBtn = actions.createEl("button", { text: "📦 Upload Vault Kit", cls: "mod-cta" });

    uploadBtn.addEventListener("click", async () => {
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Packaging...";
      try {
        const fullPaths: string[] = [];
        for (const pName of selectedPlugins) {
          await listFilesRecursively(this.app, `${cfgDir}/plugins/${pName}`, fullPaths);
        }
        for (const sName of selectedSnippets) {
          fullPaths.push(`${cfgDir}/snippets/${sName}`);
        }
        for (const tName of selectedThemes) {
          await listFilesRecursively(this.app, `${cfgDir}/themes/${tName}`, fullPaths);
        }
        if (includeAppearance && (await this.app.vault.adapter.exists(`${cfgDir}/appearance.json`))) {
          fullPaths.push(`${cfgDir}/appearance.json`);
        }
        if (includeCommunityPlugins && (await this.app.vault.adapter.exists(`${cfgDir}/community-plugins.json`))) {
          fullPaths.push(`${cfgDir}/community-plugins.json`);
        }

        const kitFiles: VaultKitFile[] = [];
        for (const fp of fullPaths) {
          const rel = fp.slice(cfgDir.length + 1).replace(/\\/g, "/");
          if (!isSafeKitPath(rel)) continue;
          if (excludeOtherPluginData && rel.startsWith("plugins/") && rel.endsWith("/data.json")) continue;

          const ext = rel.split(".").pop()?.toLowerCase() || "";
          if (TEXT_EXTS.has(ext)) {
            const content = await this.app.vault.adapter.read(fp);
            kitFiles.push({ path: rel, content, encoding: "utf-8" });
          } else {
            const ab = await this.app.vault.adapter.readBinary(fp);
            kitFiles.push({ path: rel, content: Base64.fromUint8Array(new Uint8Array(ab)), encoding: "base64" });
          }
        }

        if (kitFiles.length === 0) {
          throw new Error("No files selected to upload.");
        }

        // Batch upload in <= 8 MB chunks using reset / append / commit
        const MAX_BATCH = 8 * 1024 * 1024;
        const batches: VaultKitFile[][] = [];
        let cur: VaultKitFile[] = [];
        let curBytes = 0;
        for (const kf of kitFiles) {
          const est = kf.path.length + kf.content.length + 128;
          if (cur.length > 0 && curBytes + est > MAX_BATCH) {
            batches.push(cur);
            cur = [];
            curBytes = 0;
          }
          cur.push(kf);
          curBytes += est;
        }
        if (cur.length > 0) batches.push(cur);

        let finalVersion = "";
        for (let i = 0; i < batches.length; i++) {
          statusEl.setText(`Uploading batch ${i + 1} of ${batches.length} (${kitFiles.length} files)...`);
          let action: "replace" | "reset" | "append" | "commit" = "replace";
          if (batches.length > 1) {
            if (i === 0) action = "reset";
            else if (i === batches.length - 1) action = "commit";
            else action = "append";
          }
          const res = await this.client.uploadVaultKit(batches[i], action);
          if (res.version) finalVersion = res.version;
        }

        new Notice(`✅ Uploaded Vault Kit (${kitFiles.length} files, version ${finalVersion})`);
        if (this.onUploaded) this.onUploaded(finalVersion);
        this.close();
      } catch (err: any) {
        new Notice(`❌ Vault Kit upload failed: ${err.message}`);
        uploadBtn.disabled = false;
        uploadBtn.textContent = "📦 Upload Vault Kit";
      }
    });
  }
}

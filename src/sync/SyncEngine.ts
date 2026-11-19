import { MetadataCache, TFile, Vault } from "obsidian";
import { Base64 } from "js-base64";
import { PediaNotesPluginSettings } from "src/models/settings";
import { PediaNotesClient, PushFilePayload, RemoteManifestFile } from "src/api/PediaNotesClient";
import { CompiledNote, NoteCompiler } from "src/compiler/NoteCompiler";
import { collectImageRefs } from "src/utils/imageCollector";
import { computeGitBlobShaFromText } from "src/sync/Hasher";

export interface ConflictItem {
  repoPath: string;
  vaultPath: string;
  localSha: string;
  serverSha: string;
  baseSha?: string;
  compiled: CompiledNote;
}

export interface SyncPlan {
  canDelete: boolean;
  isAdmin: boolean;
  toPullNotes: RemoteManifestFile[];
  toPullAssets: RemoteManifestFile[];
  newLocalNotes: CompiledNote[];
  modifiedLocalNotes: CompiledNote[];
  conflicts: ConflictItem[];
  imagesToUpload: Array<{ repoPath: string; file: TFile }>;
  remoteDeletes: string[]; // Admin-only
  unchangedCount: number;
  repoToVaultPath: Map<string, string>;
}

export class SyncEngine {
  private compiler: NoteCompiler;
  private client: PediaNotesClient;

  constructor(
    private vault: Vault,
    private metadataCache: MetadataCache,
    private settings: PediaNotesPluginSettings,
    private saveSettings: () => Promise<void>
  ) {
    this.compiler = new NoteCompiler(vault, metadataCache);
    this.client = new PediaNotesClient(settings);
  }

  public updateSettings(settings: PediaNotesPluginSettings) {
    this.settings = settings;
    this.client = new PediaNotesClient(settings);
  }

  public getPublishableFiles(): TFile[] {
    return this.vault.getMarkdownFiles().filter((file) => {
      if (file.path.startsWith(".obsidian/") || file.path.startsWith("_trash/")) return false;
      if (this.settings.publishAllNotes) return true;
      const fm = this.metadataCache.getCache(file.path)?.frontmatter;
      return fm?.["publish"] === true;
    });
  }

  private mapRepoPathToVaultPath(
    repoPath: string,
    existingRepoToVault: Map<string, string>
  ): string {
    const existing = existingRepoToVault.get(repoPath);
    if (existing) return existing;

    if (repoPath.startsWith("content/")) {
      return repoPath.slice("content/".length);
    }
    if (repoPath.startsWith("static/img/")) {
      const sub = repoPath.slice("static/img/".length);
      return `${this.settings.imageFolder || "img"}/${sub}`;
    }
    if (repoPath.startsWith("static/images/")) {
      const sub = repoPath.slice("static/images/".length);
      return `${this.settings.imageFolder || "img"}/${sub}`;
    }
    return repoPath;
  }

  public async computeSyncPlan(): Promise<SyncPlan> {
    const manifest = await this.client.getManifest();
    const remoteFiles = manifest.files || [];
    const remoteMap = new Map<string, RemoteManifestFile>();
    for (const rf of remoteFiles) {
      remoteMap.set(rf.path, rf);
    }

    const localFiles = this.getPublishableFiles();
    const localByRepoPath = new Map<string, { compiled: CompiledNote; sha: string }>();
    const repoToVaultPath = new Map<string, string>();
    const referencedImages = new Map<string, TFile>();

    for (const file of localFiles) {
      const compiled = await this.compiler.compile(file);
      const sha = await computeGitBlobShaFromText(compiled.content);
      localByRepoPath.set(compiled.repoPath, { compiled, sha });
      repoToVaultPath.set(compiled.repoPath, file.path);

      const raw = await this.vault.cachedRead(file);
      for (const ref of collectImageRefs(raw, this.vault)) {
        if (ref.file) {
          const repoImgPath = `static/img/${ref.file.name}`;
          if (!referencedImages.has(repoImgPath)) {
            referencedImages.set(repoImgPath, ref.file);
          }
        }
      }
    }

    const newLocalNotes: CompiledNote[] = [];
    const modifiedLocalNotes: CompiledNote[] = [];
    const conflicts: ConflictItem[] = [];
    const toPullNotes: RemoteManifestFile[] = [];
    let unchangedCount = 0;

    // 1. Check all local notes against remote manifest & baseSha
    for (const [repoPath, { compiled, sha }] of localByRepoPath.entries()) {
      const remote = remoteMap.get(repoPath);
      const baseSha = this.settings.baseShas?.[repoPath];

      if (!remote) {
        newLocalNotes.push(compiled);
        continue;
      }

      if (remote.sha === sha) {
        unchangedCount++;
        // Ensure baseSha stays recorded
        if (this.settings.baseShas[repoPath] !== sha) {
          this.settings.baseShas[repoPath] = sha;
        }
        continue;
      }

      // Remote SHA differs from Local SHA: check 3-way baseSha
      if (!baseSha || baseSha === remote.sha) {
        // Server unchanged since last pull -> safe local edit to push
        modifiedLocalNotes.push(compiled);
      } else if (baseSha === sha) {
        // Local unchanged since last pull, server updated -> safe to pull
        toPullNotes.push(remote);
      } else {
        // Both local and server changed since baseSha -> true conflict!
        conflicts.push({
          repoPath,
          vaultPath: compiled.file.path,
          localSha: sha,
          serverSha: remote.sha,
          baseSha,
          compiled,
        });
      }
    }

    // 2. Remote notes that don't exist locally -> to pull
    for (const rf of remoteFiles) {
      if (rf.type === "note" && !localByRepoPath.has(rf.path)) {
        // Check if file exists in vault without publish:true yet
        const targetVaultPath = this.mapRepoPathToVaultPath(rf.path, repoToVaultPath);
        const existingLocal = this.vault.getAbstractFileByPath(targetVaultPath);
        if (!existingLocal) {
          toPullNotes.push(rf);
        } else if (existingLocal instanceof TFile) {
          const raw = await this.vault.cachedRead(existingLocal);
          const localSha = await computeGitBlobShaFromText(raw);
          if (localSha !== rf.sha) {
            toPullNotes.push(rf);
          }
        }
      }
    }

    // 3. Remote assets missing locally -> to pull
    const toPullAssets: RemoteManifestFile[] = [];
    const localFilesAll = this.vault.getFiles();
    const localAssetNames = new Set(localFilesAll.map((f) => f.name));
    for (const rf of remoteFiles) {
      if (rf.type === "asset") {
        const assetName = rf.path.split("/").pop() || "";
        if (assetName && !localAssetNames.has(assetName)) {
          toPullAssets.push(rf);
        }
      }
    }

    // 4. Local referenced images missing on server -> to upload
    const imagesToUpload: Array<{ repoPath: string; file: TFile }> = [];
    for (const [repoImgPath, file] of referencedImages.entries()) {
      const altPath = repoImgPath.replace(/^static\/img\//, "static/images/");
      if (!remoteMap.has(repoImgPath) && !remoteMap.has(altPath)) {
        imagesToUpload.push({ repoPath: repoImgPath, file });
      }
    }

    return {
      canDelete: Boolean(manifest.canDelete),
      isAdmin: Boolean(manifest.isAdmin),
      toPullNotes,
      toPullAssets,
      newLocalNotes,
      modifiedLocalNotes,
      conflicts,
      imagesToUpload,
      remoteDeletes: [],
      unchangedCount,
      repoToVaultPath,
    };
  }

  public async pullFromServer(
    plan: SyncPlan,
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    const paths = [
      ...plan.toPullNotes.map((f) => f.path),
      ...plan.toPullAssets.map((f) => f.path),
    ];
    if (paths.length === 0) return 0;

    const pulled = await this.client.pullFiles(paths);
    let written = 0;

    for (const item of pulled) {
      const targetPath = this.mapRepoPathToVaultPath(item.path, plan.repoToVaultPath);
      await this.ensureFolder(targetPath);

      const existing = this.vault.getAbstractFileByPath(targetPath);
      if (item.encoding === "utf-8") {
        if (existing instanceof TFile) {
          await this.vault.modify(existing, item.content);
        } else if (!existing) {
          await this.vault.create(targetPath, item.content);
        }
      } else {
        const bytes = Base64.toUint8Array(item.content);
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        if (existing instanceof TFile) {
          await this.vault.modifyBinary(existing, ab);
        } else if (!existing) {
          await this.vault.createBinary(targetPath, ab);
        }
      }

      this.settings.baseShas[item.path] = item.sha;
      written++;
      if (onProgress) onProgress(written, pulled.length);
    }

    this.settings.lastSyncAt = new Date().toISOString();
    await this.saveSettings();
    return written;
  }

  public async resolveConflictKeepServer(conflict: ConflictItem, plan: SyncPlan): Promise<void> {
    const pulled = await this.client.pullFiles([conflict.repoPath]);
    if (pulled.length === 0) return;
    const item = pulled[0];
    await this.vault.modify(conflict.compiled.file, item.content);
    this.settings.baseShas[conflict.repoPath] = item.sha;
    await this.saveSettings();
  }

  public async resolveConflictSaveCopy(conflict: ConflictItem): Promise<string> {
    const copyPath = conflict.vaultPath.replace(/\.md$/i, ` (Conflict ${Date.now()}).md`);
    let raw = await this.vault.read(conflict.compiled.file);
    // Ensure the conflict copy has publish: false so it is never accidentally published
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fmMatch) {
      const fmLines = fmMatch[1]
        .split(/\r?\n/)
        .filter((l) => !/^\s*publish:\s*/i.test(l));
      fmLines.unshift("publish: false");
      raw = `---\n${fmLines.join("\n")}\n---\n${raw.slice(fmMatch[0].length)}`;
    } else {
      raw = `---\npublish: false\n---\n${raw}`;
    }

    await this.vault.create(copyPath, raw);
    const pulled = await this.client.pullFiles([conflict.repoPath]);
    if (pulled.length > 0) {
      await this.vault.modify(conflict.compiled.file, pulled[0].content);
      this.settings.baseShas[conflict.repoPath] = pulled[0].sha;
      await this.saveSettings();
    }
    return copyPath;
  }

  public async fetchServerText(repoPath: string): Promise<string> {
    const pulled = await this.client.pullFiles([repoPath]);
    return pulled[0]?.content ?? "";
  }

  public lintNotes(notes: CompiledNote[]): string[] {
    const warnings: string[] = [];
    for (const n of notes) {
      // 1. Check trailing emoji/non-ASCII symbol at end of filename (Hugo 404 trap)
      if (/[^\w\s().-]$/.test(n.file.basename)) {
        warnings.push(`Filename "${n.file.name}" ends with a symbol/emoji (may cause 404 URLs in Hugo).`);
      }
      // 2. Check missing local images
      for (const ref of collectImageRefs(n.content, this.vault)) {
        if (!ref.file && !ref.rawRef.startsWith("/img/") && !ref.rawRef.startsWith("/images/")) {
          warnings.push(`Missing local image "${ref.rawRef}" referenced in ${n.file.path}.`);
        }
      }
    }
    return warnings;
  }

  public async pullAllFromServer(onProgress?: (done: number, total: number) => void): Promise<number> {
    const manifest = await this.client.getManifest();
    const allPaths = (manifest.files || []).map((f) => f.path);
    if (allPaths.length === 0) return 0;

    const localFiles = this.vault.getMarkdownFiles();
    const repoToVaultPath = new Map<string, string>();
    for (const file of localFiles) {
      const raw = await this.vault.cachedRead(file);
      repoToVaultPath.set(this.compiler.getRepoPath(file, raw), file.path);
    }

    const pulled = await this.client.pullFiles(allPaths);
    let written = 0;
    for (const item of pulled) {
      const targetPath = this.mapRepoPathToVaultPath(item.path, repoToVaultPath);
      await this.ensureFolder(targetPath);
      const existing = this.vault.getAbstractFileByPath(targetPath);
      if (item.encoding === "utf-8") {
        if (existing instanceof TFile) await this.vault.modify(existing, item.content);
        else if (!existing) await this.vault.create(targetPath, item.content);
      } else {
        const bytes = Base64.toUint8Array(item.content);
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        if (existing instanceof TFile) await this.vault.modifyBinary(existing, ab);
        else if (!existing) await this.vault.createBinary(targetPath, ab);
      }
      this.settings.baseShas[item.path] = item.sha;
      written++;
      if (onProgress) onProgress(written, pulled.length);
    }
    this.settings.lastSyncAt = new Date().toISOString();
    await this.saveSettings();
    return written;
  }

  public async pushToServer(
    notes: CompiledNote[],
    images: Array<{ repoPath: string; file: TFile }>,
    opts?: { force?: boolean; commitMessage?: string; onProgress?: (done: number, total: number) => void }
  ) {
    const files: PushFilePayload[] = [];
    const total = notes.length + images.length;
    let prep = 0;

    for (const note of notes) {
      files.push({
        path: note.repoPath,
        content: note.content,
        encoding: "utf-8",
        baseSha: this.settings.baseShas?.[note.repoPath],
      });
      prep++;
      if (opts?.onProgress) opts.onProgress(Math.floor(prep * 0.4), total);
    }

    for (const img of images) {
      const buf = await this.vault.readBinary(img.file);
      const b64 = Base64.fromUint8Array(new Uint8Array(buf));
      files.push({
        path: img.repoPath,
        content: b64,
        encoding: "base64",
      });
      prep++;
      if (opts?.onProgress) opts.onProgress(Math.floor(prep * 0.4), total);
    }

    const res = await this.client.pushFiles({
      files,
      force: Boolean(opts?.force),
      commitMessage: opts?.commitMessage,
      displayName: this.settings.displayName || this.settings.userName || this.settings.userEmail,
    });

    for (const [p, sha] of Object.entries(res.updatedShas || {})) {
      this.settings.baseShas[p] = sha;
    }

    // Sync local note frontmatter with server's updated_at / updated_by so Modified counter resets to 0
    const nowIso = new Date().toISOString();
    const author = this.settings.displayName || this.settings.userName || this.settings.userEmail || "Rubanbalaji G";
    for (const note of notes) {
      try {
        const raw = await this.vault.read(note.file);
        const norm = raw.replace(/\r\n/g, "\n");
        const fmMatch = norm.match(/^---\n([\s\S]*?)\n---\n?/);
        let updatedLocal = norm;
        if (fmMatch) {
          const lines = fmMatch[1]
            .split("\n")
            .filter((l) => !/^\s*(updated_at|updated_by):\s*/i.test(l));
          lines.push(`updated_at: "${nowIso}"`);
          lines.push(`updated_by: "${author}"`);
          updatedLocal = `---\n${lines.join("\n")}\n---\n${norm.slice(fmMatch[0].length)}`;
        }
        await this.vault.modify(note.file, updatedLocal);
        const newSha = await computeGitBlobShaFromText(updatedLocal);
        this.settings.baseShas[note.repoPath] = newSha;
      } catch {}
    }

    this.settings.lastSyncAt = nowIso;
    await this.saveSettings();
    if (opts?.onProgress) opts.onProgress(total, total);
    return res;
  }

  public async publishSingleNote(file: TFile) {
    const compiled = await this.compiler.compile(file);
    const raw = await this.vault.cachedRead(file);
    const refs = collectImageRefs(raw, this.vault);
    const images: Array<{ repoPath: string; file: TFile }> = [];
    for (const r of refs) {
      if (r.file) {
        images.push({ repoPath: `static/img/${r.file.name}`, file: r.file });
      }
    }
    return this.pushToServer([compiled], images, {
      commitMessage: `Update ${file.basename} via Obsidian`,
    });
  }

  private async ensureFolder(filePath: string) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      if (!p) continue;
      cur = cur ? `${cur}/${p}` : p;
      if (!this.vault.getAbstractFileByPath(cur)) {
        try {
          await this.vault.createFolder(cur);
        } catch {}
      }
    }
  }
}

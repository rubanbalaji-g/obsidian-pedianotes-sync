import { MetadataCache, TFile, Vault } from "obsidian";
import { Base64 } from "js-base64";
import { PediaNotesPluginSettings } from "src/models/settings";
import { PediaNotesClient, PushFilePayload, RemoteManifestFile } from "src/api/PediaNotesClient";
import { CompiledNote, NoteCompiler } from "src/compiler/NoteCompiler";
import { collectImageRefs } from "src/utils/imageCollector";
import { expandWikilinksInFiles } from "src/utils/wikilinks";
import { computeGitBlobShaFromBytes, computeGitBlobShaFromText } from "src/sync/Hasher";

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
    this.compiler = new NoteCompiler(
      vault,
      metadataCache,
      settings.module === "po",
      settings.expandWikilinks !== false
    );
    this.client = new PediaNotesClient(settings);
  }

  public updateSettings(settings: PediaNotesPluginSettings) {
    this.settings = settings;
    this.compiler = new NoteCompiler(
      this.vault,
      this.metadataCache,
      settings.module === "po",
      settings.expandWikilinks !== false
    );
    this.client = new PediaNotesClient(settings);
  }

  private assetRepoPath(file: TFile): string {
    const filePath = file.path.replace(/\\/g, "/");
    const imageFolder = (this.settings.imageFolder || "img").replace(/\/+$/, "");
    return this.settings.module === "po" && filePath.startsWith(`${imageFolder}/`)
      ? `static/img/${filePath.slice(imageFolder.length + 1)}`
      : `static/img/${file.name}`;
  }

  public getPublishableFiles(): TFile[] {
    return this.vault.getMarkdownFiles().filter((file) => {
      if (file.path.startsWith(".obsidian/") || file.path.startsWith("_trash/") || /\.bkup(?:-\d+)?\.md$/i.test(file.path)) return false;
      if (this.settings.publishAllNotes) return true;
      const fm = this.metadataCache.getCache(file.path)?.frontmatter;
      return fm?.["publish"] === true;
    });
  }

  public async replaceCanonicalNotes() {
    if (this.settings.module !== "po" && this.settings.module !== "theory") {
      throw new Error("Select the Theory or P&O module first.");
    }
    const manifest = await this.client.getManifest();
    if (!manifest.isAdmin) throw new Error("Only an admin can perform canonical replacement.");
    const notes = this.vault.getMarkdownFiles().filter((file) =>
      !file.path.startsWith(".obsidian/") && !file.path.startsWith("_trash/") && !/\.bkup(?:-\d+)?\.md$/i.test(file.path) &&
      this.metadataCache.getCache(file.path)?.frontmatter?.["publish"] === true
    );
    if (!notes.length) throw new Error("No publish: true notes found. Nothing was changed.");
    if (this.settings.expandWikilinks !== false) {
      await expandWikilinksInFiles(this.vault, this.metadataCache, notes);
    }
    const files: PushFilePayload[] = [];
    for (const file of notes) {
      const compiled = await this.compiler.compile(file);
      files.push({ path: compiled.repoPath, content: compiled.content, encoding: "utf-8" });
    }
    const result = await this.client.replaceCanonicalNotes(files);
    if (result.refreshed) {
      try {
        const fresh = await this.client.getManifest();
        const expected = new Set(files.map((file) => file.path));
        for (const key of Object.keys(this.settings.baseShas)) {
          if (key.startsWith("content/")) delete this.settings.baseShas[key];
        }
        for (const entry of fresh.files) {
          if (expected.has(entry.path)) this.settings.baseShas[entry.path] = entry.sha;
        }
        this.settings.lastSyncAt = new Date().toISOString();
        await this.saveSettings();
      } catch (error) {
        // GitHub has already changed. Do not report an aborted replacement.
        console.warn("Canonical replacement succeeded, but sync state could not be refreshed", error);
      }
    }
    return result;
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
          const repoImgPath = this.assetRepoPath(ref.file);
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
      if ((!baseSha && this.settings.module !== "po") || baseSha === remote.sha) {
        // Server unchanged since last pull -> safe local edit to push
        modifiedLocalNotes.push(compiled);
      } else if (baseSha === sha && this.settings.module !== "po") {
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

    // 2. Remote notes that don't exist locally -> either to pull OR locally deleted (if in baseShas)
    const remoteDeletes: string[] = [];
    for (const rf of remoteFiles) {
      if (rf.type === "note" && !localByRepoPath.has(rf.path)) {
        const targetVaultPath = this.mapRepoPathToVaultPath(rf.path, repoToVaultPath);
        const existingLocal = this.vault.getAbstractFileByPath(targetVaultPath);
        if (!existingLocal) {
          if (this.settings.baseShas?.[rf.path]) {
            // Previously synced note was deleted locally -> mark for removal on server
            remoteDeletes.push(rf.path);
          } else {
            toPullNotes.push(rf);
          }
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
      const remote = remoteMap.get(repoImgPath);
      const changed = this.settings.module === "po" && remote &&
        await computeGitBlobShaFromBytes(new Uint8Array(await this.vault.readBinary(file))) !== remote.sha;
      if (changed || (!remote && !remoteMap.has(altPath))) {
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
      remoteDeletes,
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
    const pulled = await this.client.pullFiles([conflict.repoPath]);
    if (!pulled.length) throw new Error("Could not retrieve the server version; no local files were changed.");
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "2-digit", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
    const timestamp = ["year", "month", "day", "hour", "minute", "second"].map(part).join("");
    if (!/^\d{12}$/.test(timestamp)) throw new Error("Could not generate an IST backup timestamp.");
    const copyPath = `${conflict.vaultPath}.${timestamp}.bkup`;
    if (await this.vault.adapter.exists(copyPath)) {
      throw new Error(`Backup ${copyPath} already exists. Please try again in a moment.`);
    }
    const raw = await this.vault.read(conflict.compiled.file);
    await this.vault.create(copyPath, raw);
    await this.vault.modify(conflict.compiled.file, pulled[0].content);
    this.settings.baseShas[conflict.repoPath] = pulled[0].sha;
    await this.saveSettings();
    return copyPath;
  }

  public async resolveConflictKeepLocal(conflict: ConflictItem) {
    // Recompile at click time so edits made since the sync plan are included.
    const compiled = await this.compiler.compile(conflict.compiled.file);
    const current = await this.client.getManifest();
    const remote = (current.files || []).find((file) => file.path === compiled.repoPath);
    if (!remote || remote.sha !== conflict.serverSha) {
      throw new Error("The server note changed since this conflict was displayed. Refresh the sync center and review it again.");
    }
    // Supply the observed server SHA; the server rejects a concurrent edit.
    const previousBase = this.settings.baseShas[compiled.repoPath];
    this.settings.baseShas[compiled.repoPath] = remote.sha;
    try {
      const raw = await this.vault.cachedRead(compiled.file);
      const images = collectImageRefs(raw, this.vault)
        .filter((ref): ref is typeof ref & { file: TFile } => Boolean(ref.file))
        .map((ref) => ({ repoPath: this.assetRepoPath(ref.file), file: ref.file }));
      return await this.pushToServer([compiled], images, { commitMessage: `Resolve conflict: keep ${compiled.file.basename} from vault` });
    } catch (error) {
      if (previousBase === undefined) delete this.settings.baseShas[compiled.repoPath];
      else this.settings.baseShas[compiled.repoPath] = previousBase;
      throw error;
    }
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

  public async getServerManifestFiles(): Promise<Array<{ path: string; type: "note" | "asset" }>> {
    const manifest = await this.client.getManifest();
    return (manifest.files || []).map((f) => ({
      path: f.path,
      type: f.type === "asset" ? "asset" : "note",
    }));
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
    opts?: {
      deletes?: string[];
      force?: boolean;
      commitMessage?: string;
      onProgress?: (done: number, total: number) => void;
    }
  ) {
    const files: PushFilePayload[] = [];
    const deletes = opts?.deletes || [];
    const total = notes.length + images.length + deletes.length;
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

    if (this.settings.expandWikilinks !== false && notes.length > 0) {
      await expandWikilinksInFiles(
        this.vault,
        this.metadataCache,
        notes.map((n) => n.file)
      );
      for (const note of notes) {
        const recompiled = await this.compiler.compile(note.file);
        note.content = recompiled.content;
        const idx = files.findIndex((f) => f.path === note.repoPath);
        if (idx !== -1) files[idx].content = recompiled.content;
      }
    }

    // Batch uploads into <= 8 MB JSON chunks so large image syncs never exceed server/proxy limits
    const MAX_BATCH_BYTES = 8 * 1024 * 1024;
    const batches: PushFilePayload[][] = [];
    let currentBatch: PushFilePayload[] = [];
    let currentBytes = 0;

    for (const item of files) {
      const estBytes = item.path.length + item.content.length + 128;
      if (currentBatch.length > 0 && currentBytes + estBytes > MAX_BATCH_BYTES) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBytes = 0;
      }
      currentBatch.push(item);
      currentBytes += estBytes;
    }
    if (currentBatch.length > 0 || batches.length === 0) {
      batches.push(currentBatch);
    }

    const displayName = this.settings.displayName || this.settings.userName || this.settings.userEmail;
    let totalUploaded = 0;
    let totalDeleted = 0;
    let lastBuild: { ok?: boolean; ms?: number } | undefined;
    let uploadedSoFar = 0;

    for (let i = 0; i < batches.length; i++) {
      const isLast = i === batches.length - 1;
      const batch = batches[i];
      const batchRes = await this.client.pushFiles({
        files: batch,
        deletes: isLast ? deletes : [],
        force: Boolean(opts?.force),
        commitMessage: opts?.commitMessage,
        displayName,
      });

      totalUploaded += batchRes.uploadedCount || 0;
      totalDeleted += batchRes.deletedCount || 0;
      if (batchRes.build) lastBuild = batchRes.build;

      for (const [p, sha] of Object.entries(batchRes.updatedShas || {})) {
        this.settings.baseShas[p] = sha;
      }

      uploadedSoFar += batch.length;
      if (opts?.onProgress) {
        const pct = Math.floor(total * 0.4) + Math.floor((uploadedSoFar / Math.max(files.length, 1)) * Math.ceil(total * 0.55));
        opts.onProgress(Math.min(pct, total), total);
      }
    }

    for (const delPath of deletes) {
      delete this.settings.baseShas[delPath];
    }

    const res = {
      success: true,
      uploadedCount: totalUploaded,
      deletedCount: totalDeleted,
      updatedShas: {} as Record<string, string>,
      build: lastBuild,
    };

    // Sync local note frontmatter with server's updated_at / updated_by so Modified counter resets to 0
    const nowIso = new Date().toISOString();
    const author = this.settings.displayName || this.settings.userName || this.settings.userEmail || "Rubanbalaji G";
    for (const note of this.settings.module === "po" ? [] : notes) {
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
    if (this.settings.expandWikilinks !== false) {
      await expandWikilinksInFiles(this.vault, this.metadataCache, [file]);
    }
    const compiled = await this.compiler.compile(file);
    const raw = await this.vault.cachedRead(file);
    const refs = collectImageRefs(raw, this.vault);
    const images: Array<{ repoPath: string; file: TFile }> = [];
    for (const r of refs) {
      if (r.file) {
        images.push({ repoPath: this.assetRepoPath(r.file), file: r.file });
      }
    }
    return this.pushToServer([compiled], images, {
      commitMessage: `Update ${file.basename} via Obsidian`,
    });
  }

  public async syncThemeFromServer(): Promise<void> {
    const theme = await this.client.getTheme();
    const adapter = this.vault.adapter;
    const configDir = this.vault.configDir || ".obsidian";
    const snippetsDir = `${configDir}/snippets`;

    if (!(await adapter.exists(snippetsDir))) {
      await adapter.mkdir(snippetsDir);
    }

    const enabledNames: string[] = [];
    for (const [filename, css] of Object.entries(theme.snippets || {})) {
      if (!css) continue;
      await adapter.write(`${snippetsDir}/${filename}`, css);
      enabledNames.push(filename.replace(/\.css$/i, ""));
    }

    const appearancePath = `${configDir}/appearance.json`;
    let appearance: any = {};
    try {
      if (await adapter.exists(appearancePath)) {
        appearance = JSON.parse(await adapter.read(appearancePath));
      }
    } catch {}

    appearance.accentColor = theme.accentColor || "#10b981";
    const existingSnippets: string[] = Array.isArray(appearance.enabledCssSnippets)
      ? appearance.enabledCssSnippets
      : [];
    appearance.enabledCssSnippets = Array.from(new Set([...existingSnippets, ...enabledNames]));

    await adapter.write(appearancePath, JSON.stringify(appearance, null, 2));
    this.settings.themeSynced = true;
    await this.saveSettings();
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

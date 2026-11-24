import { requestUrl } from "obsidian";
import { MODULE_URLS, PediaNotesPluginSettings } from "src/models/settings";

export interface PingResult {
  ok: boolean;
  module: string;
  email: string;
  name: string;
  isAdmin: boolean;
  allowedModules: string[];
  canDelete: boolean;
}

export interface RemoteManifestFile {
  path: string;
  sha: string;
  size: number;
  type: "note" | "asset";
}

export interface PulledFile {
  path: string;
  sha: string;
  encoding: "utf-8" | "base64";
  content: string;
}

export interface PushFilePayload {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  baseSha?: string;
}

export interface PushResponse {
  success: boolean;
  uploadedCount: number;
  deletedCount: number;
  updatedShas: Record<string, string>;
  build?: { ok: boolean; ms?: number; notes?: number };
}

export class PediaNotesClient {
  constructor(private settings: PediaNotesPluginSettings) {}

  private baseUrl(): string {
    const url = MODULE_URLS[this.settings.module];
    if (!url) throw new Error("Select Theory or P&O in plugin settings before syncing.");
    return url;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.settings.token}`,
      "Content-Type": "application/json",
    };
  }

  private safeJson(res: { status: number; text?: string; json?: any }): any {
    try {
      return res.json;
    } catch {
      const txt = String(res.text || "").trim();
      return txt ? { error: txt.slice(0, 300) } : null;
    }
  }

  private errorMessage(res: { status: number; text?: string; json?: any }, fallback: string): string {
    const data = this.safeJson(res);
    return data?.error || `${fallback} (HTTP ${res.status})`;
  }

  async ping(): Promise<PingResult> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/ping`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Auth failed"));
    }
    return this.safeJson(res) as PingResult;
  }

  async getManifest(): Promise<{
    module: string;
    isAdmin: boolean;
    canDelete: boolean;
    files: RemoteManifestFile[];
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/manifest`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Manifest fetch failed"));
    }
    return this.safeJson(res);
  }

  async replaceCanonicalNotes(
    files: PushFilePayload[],
    assetPaths?: string[]
  ): Promise<{
    success: boolean; backupBranch: string; commit: string;
    count: number; refreshed: boolean; build?: { ok: boolean };
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/canonical`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ confirm: "REPLACE_PUBLISHED_NOTES", files, assetPaths }),
      throw: false,
    });
    if (res.status >= 400) throw new Error(this.errorMessage(res, "Canonical replacement failed"));
    return this.safeJson(res);
  }

  async getTheme(): Promise<{
    module: string;
    accentColor: string;
    snippets: Record<string, string>;
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/theme`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Theme fetch failed"));
    }
    return this.safeJson(res);
  }

  async pullFiles(paths: string[]): Promise<PulledFile[]> {
    const all: PulledFile[] = [];
    const CHUNK = 120;
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += CHUNK) {
      batches.push(paths.slice(i, i + CHUNK));
    }

    const CONCURRENCY = 3;
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const slice = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (batch) => {
          const res = await requestUrl({
            url: `${this.baseUrl()}/_api/plugin/pull`,
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ paths: batch }),
            throw: false,
          });
          if (res.status >= 400) {
            throw new Error(this.errorMessage(res, "Pull failed"));
          }
          const data = this.safeJson(res);
          return Array.isArray(data?.files) ? (data.files as PulledFile[]) : [];
        })
      );
      for (const r of results) all.push(...r);
    }
    return all;
  }

  async pushFiles(params: {
    files: PushFilePayload[];
    deletes?: string[];
    force?: boolean;
    commitMessage?: string;
    displayName?: string;
  }): Promise<PushResponse> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/push`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
      throw: false,
    });
    if (res.status === 409) {
      const data = this.safeJson(res);
      const err: any = new Error(data?.error || "Conflict detected on server");
      err.status = 409;
      err.conflicts = data?.conflicts || [];
      throw err;
    }
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Push failed"));
    }
    const data = this.safeJson(res);
    if (!data) {
      throw new Error(`Push returned empty/non-JSON response (HTTP ${res.status})`);
    }
    return data as PushResponse;
  }

  async getLatestRelease(): Promise<{
    tag: string;
    version: string;
    assets: Record<string, string>;
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/latest-release`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Latest release check failed"));
    }
    return this.safeJson(res);
  }

  async getVaultKitMeta(): Promise<{
    version: string;
    updatedAt: string;
    updatedBy: string;
    count: number;
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/vault-kit?meta=1`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Vault kit metadata fetch failed"));
    }
    return this.safeJson(res);
  }

  async getVaultKit(): Promise<{
    version: string;
    updatedAt: string;
    updatedBy: string;
    count: number;
    files: Array<{ path: string; content: string; encoding: "utf-8" | "base64" }>;
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/vault-kit`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Vault kit fetch failed"));
    }
    return this.safeJson(res);
  }

  async uploadVaultKit(
    files: Array<{ path: string; content: string; encoding: "utf-8" | "base64" }>,
    action: "replace" | "reset" | "append" | "commit" = "replace"
  ): Promise<{ ok?: boolean; version?: string; count?: number; staged?: number }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/vault-kit`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ action, files }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Vault kit upload failed"));
    }
    return this.safeJson(res);
  }

  async cleanupServerImages(dryRun = true): Promise<{
    dryRun: boolean;
    totalImages: number;
    unusedCount?: number;
    removedCount?: number;
    totalBytes: number;
    unused?: string[];
    removed?: string[];
  }> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/cleanup-images`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ dryRun }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(this.errorMessage(res, "Server image cleanup failed"));
    }
    return this.safeJson(res);
  }
}

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
    return MODULE_URLS[this.settings.module] || MODULE_URLS.theory;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.settings.token}`,
      "Content-Type": "application/json",
    };
  }

  async ping(): Promise<PingResult> {
    const res = await requestUrl({
      url: `${this.baseUrl()}/_api/plugin/ping`,
      method: "GET",
      headers: this.headers(),
      throw: false,
    });
    if (res.status >= 400) {
      const msg = res.json?.error || `Auth failed (${res.status})`;
      throw new Error(msg);
    }
    return res.json as PingResult;
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
      throw new Error(res.json?.error || `Manifest fetch failed (${res.status})`);
    }
    return res.json;
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
      throw new Error(res.json?.error || `Theme fetch failed (${res.status})`);
    }
    return res.json;
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
            throw new Error(res.json?.error || `Pull failed (${res.status})`);
          }
          return Array.isArray(res.json?.files) ? (res.json.files as PulledFile[]) : [];
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
      const err: any = new Error(res.json?.error || "Conflict detected on server");
      err.status = 409;
      err.conflicts = res.json?.conflicts || [];
      throw err;
    }
    if (res.status >= 400) {
      throw new Error(res.json?.error || `Push failed (${res.status})`);
    }
    return res.json as PushResponse;
  }
}

import { App, Plugin, requestUrl } from "obsidian";
import { PediaNotesClient } from "src/api/PediaNotesClient";

export interface PluginReleaseInfo {
  version: string;
  tag: string;
  assets: Record<string, string>;
}

export function isNewerSemver(remote: string, local: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const r = parse(remote);
  const l = parse(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

export async function checkLatestPluginRelease(
  client: PediaNotesClient,
  currentVersion: string
): Promise<PluginReleaseInfo | null> {
  try {
    const rel = await client.getLatestRelease();
    if (rel?.version && isNewerSemver(rel.version, currentVersion)) {
      return rel;
    }
    return null;
  } catch {
    return null;
  }
}

export async function updateSelfAndReload(
  app: App,
  plugin: Plugin,
  release: PluginReleaseInfo
): Promise<void> {
  const pluginId = plugin.manifest.id;
  const pluginDir = `${app.vault.configDir}/plugins/${pluginId}`;
  await app.vault.adapter.mkdir(pluginDir).catch(() => {});

  const requiredFiles = ["main.js", "manifest.json", "styles.css"];
  for (const name of requiredFiles) {
    const url = release.assets[name];
    if (!url) {
      if (name === "styles.css") continue;
      throw new Error(`Release ${release.version} is missing ${name}`);
    }
    const res = await requestUrl({ url, method: "GET", throw: false });
    if (res.status >= 400) {
      throw new Error(`Failed to download ${name} (HTTP ${res.status})`);
    }
    await app.vault.adapter.write(`${pluginDir}/${name}`, res.text);
  }

  const pluginsApi = (app as any).plugins;
  if (pluginsApi?.loadManifests) {
    await pluginsApi.loadManifests().catch(() => {});
  }
  if (pluginsApi?.disablePlugin && pluginsApi?.enablePlugin) {
    app.workspace.detachLeavesOfType("pedianotes-sync-view");
    await pluginsApi.disablePlugin(pluginId);
    await pluginsApi.enablePlugin(pluginId);
    const reloaded = pluginsApi.getPlugin?.(pluginId);
    if (reloaded?.openSyncTab) {
      await reloaded.openSyncTab();
    }
  }
}

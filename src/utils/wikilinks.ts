import { MetadataCache, TFile, Vault } from "obsidian";

const CODE_BLOCK_RE = /(```[\s\S]*?```)|(`[^`\n]+`)/g;
const WIKILINK_RE = /(!?\[\[)([^\]|#\n]+?)((?:#[^\]|\n]+)?(?:\|[^\]\n]*)?\]\])/g;

/**
 * Expands short [[wikilink]] and ![[wikilink]] targets to their full vault path
 * using Obsidian's metadataCache resolution, preserving headings, aliases, and code blocks.
 */
export function expandWikilinksInText(
  text: string,
  sourcePath: string,
  metadataCache: MetadataCache
): { text: string; changedCount: number } {
  const codeBlocks: string[] = [];
  const masked = text.replace(CODE_BLOCK_RE, (m) => {
    codeBlocks.push(m);
    return `%%%PN_CODE_${codeBlocks.length - 1}%%%`;
  });

  let changedCount = 0;
  const replaced = masked.replace(WIKILINK_RE, (full, prefix: string, rawTarget: string, suffix: string) => {
    const target = rawTarget.trim();
    if (!target || /^(?:https?:|obsidian:|mailto:)/i.test(target)) return full;

    const dest = metadataCache.getFirstLinkpathDest(target, sourcePath);
    if (!(dest instanceof TFile)) return full;

    const fullPath =
      dest.extension.toLowerCase() === "md"
        ? dest.path.replace(/\.md$/i, "")
        : dest.path;

    if (target === fullPath) return full;
    changedCount++;
    return `${prefix}${fullPath}${suffix}`;
  });

  const restored = replaced.replace(
    /%%%PN_CODE_(\d+)%%%/g,
    (_, idx) => codeBlocks[Number(idx)]
  );
  return { text: restored, changedCount };
}

/**
 * Updates local Markdown files in the vault so [[wikilink]] becomes [[full/path/to/wikilink]].
 */
export async function expandWikilinksInFiles(
  vault: Vault,
  metadataCache: MetadataCache,
  files: TFile[]
): Promise<{ filesUpdated: number; linksUpdated: number }> {
  let filesUpdated = 0;
  let linksUpdated = 0;

  for (const file of files) {
    if (file.extension.toLowerCase() !== "md") continue;
    let fileChanged = 0;
    await vault.process(file, (content) => {
      const res = expandWikilinksInText(content, file.path, metadataCache);
      fileChanged = res.changedCount;
      return res.changedCount > 0 ? res.text : content;
    });
    if (fileChanged > 0) {
      filesUpdated++;
      linksUpdated += fileChanged;
    }
  }

  return { filesUpdated, linksUpdated };
}

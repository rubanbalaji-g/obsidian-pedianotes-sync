import { MetadataCache, TFile, Vault } from "obsidian";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff", "tif", "ico"]);
const CONVERTIBLE_EXTS = new Set(["png", "jpg", "jpeg", "bmp"]);

function isVaultContentFile(file: TFile): boolean {
  const p = file.path;
  return !p.startsWith(".obsidian/") && !p.startsWith(".trash/") && !p.startsWith("_trash/");
}

export async function findUnusedImages(vault: Vault): Promise<{
  unused: TFile[];
  totalImages: number;
  unusedBytes: number;
}> {
  const allFiles = vault.getFiles().filter(isVaultContentFile);
  const images = allFiles.filter((f) => IMAGE_EXTS.has(f.extension.toLowerCase()));
  const textFiles = allFiles.filter((f) => ["md", "canvas", "html"].includes(f.extension.toLowerCase()));

  const chunks: string[] = [];
  for (const tf of textFiles) {
    try {
      chunks.push(await vault.cachedRead(tf));
    } catch {
      // Ignore unreadable files
    }
  }

  let combined = chunks.join("\n");
  try {
    combined = decodeURIComponent(combined);
  } catch {
    // Keep raw text if malformed percent-encoding exists
  }
  const combinedLower = combined.toLowerCase();

  const unused: TFile[] = [];
  let unusedBytes = 0;
  for (const img of images) {
    const baseLower = img.name.toLowerCase();
    const relLower = img.path.toLowerCase();
    if (!combinedLower.includes(baseLower) && !combinedLower.includes(relLower)) {
      unused.push(img);
      unusedBytes += img.stat.size;
    }
  }

  return { unused, totalImages: images.length, unusedBytes };
}

export async function removeUnusedImages(vault: Vault, unused: TFile[]): Promise<number> {
  let removed = 0;
  for (const img of unused) {
    try {
      await vault.trash(img, false);
      removed++;
    } catch {
      // Skip if already removed
    }
  }
  return removed;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function encodeImageAsWebP(buffer: ArrayBuffer, mimeType: string, quality = 0.9): Promise<ArrayBuffer> {
  const blob = new Blob([buffer], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const webpBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("WebP encoding failed"))),
        "image/webp",
        quality
      );
    });
    return await webpBlob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

export async function convertAllImagesToWebP(
  vault: Vault,
  _metadataCache: MetadataCache,
  onProgress?: (done: number, total: number) => void
): Promise<{
  deduplicated: number;
  converted: number;
  linksUpdated: number;
  filesUpdated: number;
  savedBytes: number;
}> {
  const allFiles = vault.getFiles().filter(isVaultContentFile);
  const images = allFiles.filter((f) => IMAGE_EXTS.has(f.extension.toLowerCase()));
  const textFiles = allFiles.filter((f) => f.extension.toLowerCase() === "md");

  // Read all markdown text to prefer keeping already-referenced canonical paths
  const noteTexts = new Map<TFile, string>();
  for (const tf of textFiles) {
    noteTexts.set(tf, await vault.read(tf));
  }
  const allTextLower = Array.from(noteTexts.values()).join("\n").toLowerCase();

  // 1. Group all images by SHA-256 to deduplicate
  const byHash = new Map<string, Array<{ file: TFile; buf: ArrayBuffer }>>();
  for (const img of images) {
    const buf = await vault.readBinary(img);
    const h = await sha256Hex(buf);
    const list = byHash.get(h) || [];
    list.push({ file: img, buf });
    byHash.set(h, list);
  }

  const relMap = new Map<string, string>();
  const baseMap = new Map<string, string>();
  const canonicalEntries: Array<{ file: TFile; buf: ArrayBuffer }> = [];
  const toTrash: TFile[] = [];
  let deduplicated = 0;
  let savedBytes = 0;

  for (const group of byHash.values()) {
    group.sort((a, b) => {
      const aUsed = allTextLower.includes(a.file.path.toLowerCase()) ? 0 : 1;
      const bUsed = allTextLower.includes(b.file.path.toLowerCase()) ? 0 : 1;
      if (aUsed !== bUsed) return aUsed - bUsed;
      if (a.file.path.length !== b.file.path.length) return a.file.path.length - b.file.path.length;
      return a.file.path.localeCompare(b.file.path);
    });

    const canon = group[0];
    const ext = canon.file.extension.toLowerCase();
    const targetRel = CONVERTIBLE_EXTS.has(ext)
      ? canon.file.path.replace(/\.[^.]+$/, ".webp")
      : canon.file.path;
    const targetBase = targetRel.split("/").pop() || targetRel;

    canonicalEntries.push(canon);
    for (const item of group) {
      relMap.set(item.file.path.toLowerCase(), targetRel);
      baseMap.set(item.file.name.toLowerCase(), targetBase);
      if (item.file !== canon.file) {
        toTrash.push(item.file);
        deduplicated++;
        savedBytes += item.file.stat.size;
      }
    }
  }

  // 2. Convert convertible canonical images to WebP
  let converted = 0;
  let done = 0;
  const total = canonicalEntries.length;
  for (const { file, buf } of canonicalEntries) {
    done++;
    if (onProgress) onProgress(done, total);
    const ext = file.extension.toLowerCase();
    if (!CONVERTIBLE_EXTS.has(ext)) continue;

    const webpPath = file.path.replace(/\.[^.]+$/, ".webp");
    const webpBuf = await encodeImageAsWebP(buf, mimeForExt(ext), 0.9);
    const existing = vault.getAbstractFileByPath(webpPath);
    if (existing instanceof TFile) {
      await vault.modifyBinary(existing, webpBuf);
    } else {
      await vault.createBinary(webpPath, webpBuf);
    }
    savedBytes += Math.max(0, file.stat.size - webpBuf.byteLength);
    toTrash.push(file);
    converted++;
  }

  // 3. Rewrite image links in Markdown notes
  const WIKI_IMG_RE = /(!?\[\[)([^\]|#\n]+?\.(?:png|jpe?g|bmp|webp))((?:[|#][^\]\n]*)?\]\])/gi;
  const MD_IMG_RE = /(!?\[[^\]]*\]\()([^)\n]+?\.(?:png|jpe?g|bmp|webp))(\))/gi;

  let filesUpdated = 0;
  let linksUpdated = 0;

  for (const [tf, origText] of noteTexts.entries()) {
    let countInFile = 0;
    let nextText = origText.replace(WIKI_IMG_RE, (full, prefix: string, rawTarget: string, suffix: string) => {
      const target = rawTarget.trim();
      const key = target.replace(/^\/+/, "").toLowerCase();
      if (relMap.has(key)) {
        const mapped = relMap.get(key)!;
        if (mapped !== target) {
          countInFile++;
          return `${prefix}${mapped}${suffix}`;
        }
        return full;
      }
      const bkey = (target.split("/").pop() || target).toLowerCase();
      if (baseMap.has(bkey)) {
        const mappedBase = baseMap.get(bkey)!;
        const slashIdx = target.lastIndexOf("/");
        const nextTarget = slashIdx !== -1 ? `${target.slice(0, slashIdx + 1)}${mappedBase}` : mappedBase;
        if (nextTarget !== target) {
          countInFile++;
          return `${prefix}${nextTarget}${suffix}`;
        }
      }
      return full;
    });

    nextText = nextText.replace(MD_IMG_RE, (full, prefix: string, rawTarget: string, suffix: string) => {
      const target = rawTarget.trim();
      if (/^https?:\/\//i.test(target)) return full;
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {}
      const key = decoded.replace(/^\.?\//, "").toLowerCase();
      if (relMap.has(key)) {
        const mapped = relMap.get(key)!;
        if (mapped !== target) {
          countInFile++;
          return `${prefix}${mapped}${suffix}`;
        }
        return full;
      }
      const bkey = (decoded.split("/").pop() || decoded).toLowerCase();
      if (baseMap.has(bkey)) {
        const mappedBase = baseMap.get(bkey)!;
        const slashIdx = decoded.lastIndexOf("/");
        const nextTarget = slashIdx !== -1 ? `${decoded.slice(0, slashIdx + 1)}${mappedBase}` : mappedBase;
        if (nextTarget !== target) {
          countInFile++;
          return `${prefix}${nextTarget}${suffix}`;
        }
      }
      return full;
    });

    if (countInFile > 0 && nextText !== origText) {
      await vault.modify(tf, nextText);
      filesUpdated++;
      linksUpdated += countInFile;
    }
  }

  // 4. Trash replaced/duplicate originals
  for (const f of toTrash) {
    try {
      await vault.trash(f, false);
    } catch {
      // Ignore if already deleted
    }
  }

  return { deduplicated, converted, linksUpdated, filesUpdated, savedBytes };
}

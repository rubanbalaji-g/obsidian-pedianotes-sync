import { TFile, Vault } from "obsidian";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

export interface ImageRef {
  rawRef: string;
  file?: TFile;
}

export function collectImageRefs(content: string, vault: Vault): ImageRef[] {
  const refs: ImageRef[] = [];
  const seen = new Set<string>();

  const wikilinkRe = /!\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikilinkRe.exec(content)) !== null) {
    const inner = m[1].replace(/\\\|/g, "|");
    const rawRef = inner.split("|")[0].trim();
    if (!seen.has(rawRef) && isLocalImage(rawRef)) {
      seen.add(rawRef);
      refs.push({ rawRef, file: resolveFile(rawRef, vault) });
    }
  }

  const mdRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((m = mdRe.exec(content)) !== null) {
    const inner = m[2].split("|")[0].trim();
    if (inner.startsWith("http://") || inner.startsWith("https://")) continue;
    const rawRef = decodeURIComponent(inner);
    const name = rawRef.split("/").pop()?.split("\\").pop() ?? rawRef;
    if (!seen.has(name) && isLocalImage(name)) {
      seen.add(name);
      refs.push({ rawRef, file: resolveFile(name, vault) });
    }
  }

  return refs;
}

function isLocalImage(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

function resolveFile(nameOrPath: string, vault: Vault): TFile | undefined {
  const clean = nameOrPath.replace(/^\/+/, "");
  const direct = vault.getFileByPath(clean);
  if (direct) return direct;

  const basename = clean.split("/").pop()?.split("\\").pop() ?? clean;
  return vault.getFiles().find(
    (f) => f.name === basename && IMAGE_EXTENSIONS.has(f.extension.toLowerCase())
  );
}

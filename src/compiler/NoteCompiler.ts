import { MetadataCache, TFile, Vault } from "obsidian";

export interface CompiledNote {
  file: TFile;
  repoPath: string;
  content: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const CODE_BLOCK_OR_COMMENT_RE = /(```[\s\S]*?```)|(%%[\s\S]*?%%)/g;
const BLOCK_REF_RE = /\s*\^[a-zA-Z0-9-]+$/gm;
const WIKILINK_IMAGE_RE = /!\[\[([^\]]+)\]\]/g;

export class NoteCompiler {
  constructor(private vault: Vault, private metadataCache: MetadataCache, private preserveVault = false) {}

  public getRepoPath(file: TFile, rawContent?: string): string {
    if (this.preserveVault) return `content/${file.path.replace(/\\/g, "/")}`;
    const fm = this.metadataCache.getCache(file.path)?.frontmatter;
    const isMainIndex =
      fm?.["main.index"] === true ||
      (rawContent ? /(?:^|\n)\s*main\.index:\s*true/i.test(rawContent) : false);
    const isFolderIndex =
      fm?.["folder.index"] === true ||
      (rawContent ? /(?:^|\n)\s*folder\.index:\s*true/i.test(rawContent) : false);

    const normalizedPath = file.path.replace(/\\/g, "/");
    const lastSlash = normalizedPath.lastIndexOf("/");
    const folderPath = lastSlash !== -1 ? normalizedPath.substring(0, lastSlash) : "";
    const fileName = (file.name || normalizedPath.split("/").pop() || "").toLowerCase();

    if (
      fileName === "tree.weight.md" ||
      fileName === "tree.weight" ||
      fileName === "do.not.display.md" ||
      fileName === "do.not.display"
    ) {
      return `content/${fileName}`;
    }

    let relPath = normalizedPath;
    if (isMainIndex) {
      relPath = "_index.md";
    } else if (isFolderIndex || fileName === "index.md") {
      relPath = folderPath ? `${folderPath}/_index.md` : "_index.md";
    }
    return `content/${relPath}`;
  }

  public async compile(file: TFile): Promise<CompiledNote> {
    const raw = await this.vault.cachedRead(file);
    const repoPath = this.getRepoPath(file, raw);
    if (this.preserveVault) return { file, repoPath, content: raw };
    const fileName = file.name.toLowerCase();

    if (
      fileName === "tree.weight.md" ||
      fileName === "tree.weight" ||
      fileName === "do.not.display.md" ||
      fileName === "do.not.display"
    ) {
      const match = raw.match(FRONTMATTER_RE);
      const body = match ? raw.substring(match[0].length).trim() : raw;
      return { file, repoPath, content: body };
    }

    let frontmatterBlock = "";
    let body = raw;
    const match = raw.match(FRONTMATTER_RE);
    if (match) {
      frontmatterBlock = match[0];
      body = raw.substring(match[0].length);
    }

    // 1. Strip Obsidian comments %%...%% outside fenced code blocks
    body = body.replace(CODE_BLOCK_OR_COMMENT_RE, (m, codeBlock) => (codeBlock ? codeBlock : ""));

    // 2. Strip block reference anchors (^block-id)
    body = body.replace(BLOCK_REF_RE, "");

    // 3. Convert Obsidian wikilink images ![[image.png|right|200]] -> ![image.png|right|200](/img/image.png)
    body = this.convertWikilinkImages(body);

    // 4. Normalize indented alphabetical/roman sublists to 1. for Hugo Goldmark
    body = this.normalizeSublists(body);

    let content: string;
    if (frontmatterBlock) {
      content = (frontmatterBlock + body).replace(/\r\n/g, "\n");
    } else {
      content = `---\npublish: true\n---\n${body}`.replace(/\r\n/g, "\n");
    }

    content = content.replace(/\/img\/user\/00\.Attachments\/(?:system_cards\/)?([^\s"')]+)/g, "/images/$1");
    return { file, repoPath, content };
  }

  private normalizeSublists(content: string): string {
    const CODE_BLOCK_RE = /(```[\s\S]*?```)|(`[^`\n]+`)/g;
    const INDENTED_SUBLIST_RE = /^(\s*(?:>\s*)*\s+)(?:[a-zA-Z]|[ivxIVX]{1,4})\.\s+(.*)$/gm;

    const codeBlocks: string[] = [];
    let sanitized = content.replace(CODE_BLOCK_RE, (m) => {
      codeBlocks.push(m);
      return `%%%CODE_BLOCK_PRESERVE_${codeBlocks.length - 1}%%%`;
    });

    sanitized = sanitized.replace(INDENTED_SUBLIST_RE, "$11. $2");
    sanitized = sanitized.replace(/%%%CODE_BLOCK_PRESERVE_(\d+)%%%/g, (_, idx) => codeBlocks[Number(idx)]);
    return sanitized;
  }

  private convertWikilinkImages(content: string): string {
    return content.replace(WIKILINK_IMAGE_RE, (_match, inner) => {
      const raw = inner.replace(/\\\|/g, "|");
      const parts = raw.split("|");
      const target = parts[0].trim();
      const modifiers = parts
        .slice(1)
        .map((p: string) => p.trim())
        .filter(Boolean);

      const fileName = target.split("/").pop()?.split("\\").pop() ?? target;
      const alt = modifiers.length > 0 ? `${fileName}|${modifiers.join("|")}` : fileName;
      return `![${alt}](/img/${encodeURIComponent(fileName).replace(/%20/g, " ")})`;
    });
  }
}

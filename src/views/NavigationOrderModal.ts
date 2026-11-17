import { App, Modal, Notice, Setting, TFile } from "obsidian";

interface NoteOrderItem {
  file: TFile;
  title: string;
  weight: number;
}

export class NavigationOrderModal extends Modal {
  private selectedFolder = "";
  private notesInFolder: NoteOrderItem[] = [];

  constructor(app: App) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Section Navigation Ordering" });
    contentEl.createEl("p", {
      text: "Reorder notes within any specialty folder. Saves 'weight' frontmatter to control sidebar order.",
    });

    const folders = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const folderName = file.parent?.name;
      if (folderName && folderName !== "/" && !file.parent?.isRoot()) {
        folders.add(folderName);
      }
    }
    const folderList = Array.from(folders).sort();
    if (folderList.length === 0) {
      contentEl.createEl("p", { text: "No specialty folders found." });
      return;
    }

    this.selectedFolder = this.selectedFolder || folderList[0];
    const controls = contentEl.createEl("div");
    const listContainer = contentEl.createEl("div");

    new Setting(controls)
      .setName("Specialty Folder")
      .addDropdown((dd) => {
        for (const f of folderList) dd.addOption(f, f);
        dd.setValue(this.selectedFolder);
        dd.onChange((val) => {
          this.selectedFolder = val;
          this.loadNotes();
          this.renderList(listContainer);
        });
      });

    this.loadNotes();
    this.renderList(listContainer);

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText("Save Order to Frontmatter")
          .setCta()
          .onClick(async () => {
            await this.saveOrder();
            this.close();
          })
      )
      .addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }

  private loadNotes() {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.parent?.name === this.selectedFolder && f.name !== "_index.md");
    this.notesInFolder = files
      .map((file) => {
        const fm = this.app.metadataCache.getCache(file.path)?.frontmatter;
        return {
          file,
          title: String(fm?.title || file.basename),
          weight: typeof fm?.weight === "number" ? fm.weight : 9999,
        };
      })
      .sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title));
  }

  private renderList(container: HTMLElement) {
    container.empty();
    this.notesInFolder.forEach((item, idx) => {
      const row = container.createEl("div", {
        attr: {
          style: "display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--background-modifier-border);",
        },
      });
      row.createEl("span", { text: `${idx + 1}. ${item.title}` });
      const btns = row.createEl("div", { attr: { style: "display:flex;gap:4px;" } });
      const up = btns.createEl("button", { text: "↑" });
      up.disabled = idx === 0;
      up.addEventListener("click", () => {
        const tmp = this.notesInFolder[idx - 1];
        this.notesInFolder[idx - 1] = this.notesInFolder[idx];
        this.notesInFolder[idx] = tmp;
        this.renderList(container);
      });
      const down = btns.createEl("button", { text: "↓" });
      down.disabled = idx === this.notesInFolder.length - 1;
      down.addEventListener("click", () => {
        const tmp = this.notesInFolder[idx + 1];
        this.notesInFolder[idx + 1] = this.notesInFolder[idx];
        this.notesInFolder[idx] = tmp;
        this.renderList(container);
      });
    });
  }

  private async saveOrder() {
    for (let i = 0; i < this.notesInFolder.length; i++) {
      await this.app.fileManager.processFrontMatter(this.notesInFolder[i].file, (fm) => {
        fm["weight"] = (i + 1) * 10;
      });
    }
    new Notice(`Updated ordering for ${this.notesInFolder.length} notes in ${this.selectedFolder}`);
  }
}

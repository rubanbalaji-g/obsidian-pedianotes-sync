export type PediaModule = "theory" | "practical" | "osce";

export interface PediaNotesPluginSettings {
  token: string;
  userEmail: string;
  userName: string;
  isAdmin: boolean;
  allowedModules: string[];
  module: PediaModule;
  autoPullOnOpen: boolean;
  publishAllNotes: boolean;
  imageFolder: string;
  baseShas: Record<string, string>; // repoPath -> last synced Git blob SHA
  lastSyncAt: string;
}

export const DEFAULT_SETTINGS: PediaNotesPluginSettings = {
  token: "",
  userEmail: "",
  userName: "",
  isAdmin: false,
  allowedModules: [],
  module: "theory",
  autoPullOnOpen: true,
  publishAllNotes: false,
  imageFolder: "img",
  baseShas: {},
  lastSyncAt: "",
};

export const MODULE_URLS: Record<PediaModule, string> = {
  theory: "https://theory.pedianotes.in",
  practical: "https://practical.pedianotes.in",
  osce: "https://osce.pedianotes.in",
};

export const AUTH_PORTAL_URL = "https://auth.pedianotes.in";

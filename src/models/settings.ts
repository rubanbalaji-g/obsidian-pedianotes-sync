export type PediaModule = "theory" | "practical" | "osce";

export interface PediaNotesPluginSettings {
  token: string;
  userEmail: string;
  userName: string;
  displayName: string;
  isAdmin: boolean;
  allowedModules: string[];
  module: PediaModule;
  autoPullOnOpen: boolean;
  publishAllNotes: boolean;
  imageFolder: string;
  baseShas: Record<string, string>; // repoPath -> last synced Git blob SHA
  offlineQueue: string[]; // vault paths queued when offline
  themeSynced: boolean;
  lastSyncAt: string;
}

export const DEFAULT_SETTINGS: PediaNotesPluginSettings = {
  token: "",
  userEmail: "",
  userName: "",
  displayName: "",
  isAdmin: false,
  allowedModules: [],
  module: "theory",
  autoPullOnOpen: true,
  publishAllNotes: false,
  imageFolder: "img",
  baseShas: {},
  offlineQueue: [],
  themeSynced: false,
  lastSyncAt: "",
};

export const MODULE_URLS: Record<PediaModule, string> = {
  theory: "https://theory.pedianotes.in",
  practical: "https://practical.pedianotes.in",
  osce: "https://osce.pedianotes.in",
};

export const AUTH_PORTAL_URL = "https://auth.pedianotes.in";

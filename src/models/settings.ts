export type PediaModule = "theory" | "po" | "unselected";

export interface StoredModuleSyncState {
  baseShas: Record<string, string>;
  offlineQueue: string[];
}

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
  expandWikilinks: boolean;
  imageFolder: string;
  baseShas: Record<string, string>; // repoPath -> last synced Git blob SHA
  offlineQueue: string[]; // vault paths queued when offline
  themeSynced: boolean;
  lastSyncAt: string;
  vaultSetupCompleted: boolean;
  installedKitVersion: string;
  moduleSyncStates?: Record<string, StoredModuleSyncState>;
}

export const DEFAULT_SETTINGS: PediaNotesPluginSettings = {
  token: "",
  userEmail: "",
  userName: "",
  displayName: "",
  isAdmin: false,
  allowedModules: [],
  module: "theory",
  autoPullOnOpen: false,
  publishAllNotes: false,
  expandWikilinks: true,
  imageFolder: "img",
  baseShas: {},
  offlineQueue: [],
  themeSynced: false,
  lastSyncAt: "",
  vaultSetupCompleted: false,
  installedKitVersion: "",
};

export const MODULE_URLS: Record<PediaModule, string> = {
  theory: "https://theory.pedianotes.in",
  po: "https://practical2.pedianotes.in",
  unselected: "",
};

export const AUTH_PORTAL_URL = "https://auth.pedianotes.in";

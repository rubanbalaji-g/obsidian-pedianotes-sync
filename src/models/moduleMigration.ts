import { PediaNotesPluginSettings } from "./settings";

// Never silently map a retired module to a different site. Preserve its sync
// state for recovery, and require an explicit choice of a current destination.
export function retireLegacyModule(settings: PediaNotesPluginSettings, oldModule: string): boolean {
  if (!oldModule || oldModule === "theory" || oldModule === "po" || oldModule === "unselected") return false;
  settings.moduleSyncStates = {
    ...settings.moduleSyncStates,
    [oldModule]: {
      baseShas: { ...(settings.baseShas || {}) },
      offlineQueue: [...(settings.offlineQueue || [])],
    },
  };
  settings.module = "unselected";
  settings.baseShas = {};
  settings.offlineQueue = [];
  settings.themeSynced = false;
  return true;
}

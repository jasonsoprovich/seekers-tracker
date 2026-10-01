// Inline script (rendered in the (app) layout) that re-applies the saved
// GeoCities preference before first paint, so a reload doesn't flash the
// normal theme. Mirrors the storage key in GeocitiesTheme.tsx.
export const GEOCITIES_STORAGE_KEY = "seekers-geocities";

export const GEOCITIES_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  GEOCITIES_STORAGE_KEY,
)})==="on")document.documentElement.setAttribute("data-theme","geocities")}catch(e){}`;

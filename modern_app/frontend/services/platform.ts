export type RuntimePlatform = "browser" | "desktop" | "android" | "ios";

let loggedWindow: Window | undefined;

// No SDK imports, IPC, promises or effects are needed to select the startup.
export function getRuntimePlatformSync(): RuntimePlatform {
  if (typeof window === "undefined") return "browser";
  const tauri = "__TAURI_INTERNALS__" in window;
  const navigator = window.navigator;
  let platform: RuntimePlatform = "browser";
  if (tauri) {
    const userAgent = navigator?.userAgent || "";
    if (/Android/i.test(userAgent)) platform = "android";
    else if (/iPhone|iPad|iPod/i.test(userAgent)
      || (navigator?.platform === "MacIntel" && navigator.maxTouchPoints > 1)) platform = "ios";
    else platform = "desktop";
  }
  if (process.env.NODE_ENV === "development" && loggedWindow !== window) {
    loggedWindow = window;
    console.info("[platform]", { tauri, platform });
  }
  return platform;
}

export function assertDesktopLocalApiAvailable(): void {
  const platform = getRuntimePlatformSync();
  if (platform === "android" || platform === "ios") {
    throw new Error("Desktop local API is not available on mobile.");
  }
}

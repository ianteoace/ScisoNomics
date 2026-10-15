export type RuntimePlatform = "browser" | "desktop" | "android" | "ios";

let loggedWindow: Window | undefined;

// Mobile WebViews expose their user agent synchronously, while the Tauri bridge
// can appear after React's first render. Detect mobile first so startup never
// falls through to the desktop backend gate while native globals are settling.
export function getRuntimePlatformSync(): RuntimePlatform {
  if (typeof window === "undefined") return "browser";
  const tauri = "__TAURI_INTERNALS__" in window;
  const navigator = window.navigator;
  const userAgent = navigator?.userAgent || "";
  const android = /Android/i.test(userAgent);
  const ios = /iPhone|iPad|iPod/i.test(userAgent)
    || (navigator?.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const platform: RuntimePlatform = android
    ? "android"
    : ios
      ? "ios"
      : tauri
        ? "desktop"
        : "browser";

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

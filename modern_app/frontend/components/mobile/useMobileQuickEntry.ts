"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useMobileAccount } from "./account/MobileAccountProvider";
import { isMobileRecoveryBlocked, MOBILE_RECOVERY_CHANGED } from "../../services/mobileRecoveryState";
import { getPendingDeviceState, getPendingDeviceServerState, subscribePendingDevice } from "../../services/supabaseCloudAuth";
import { getGoogleOAuthState, getGoogleOAuthServerState, subscribeGoogleOAuth } from "../../services/supabaseGoogleAuth";
import { getPendingQuickEntry, getQuickEntryServerSnapshot, subscribeQuickEntry } from "../../services/mobileQuickEntry";
import { getRuntimePlatformSync } from "../../services/platform";
import { MOBILE_DIALOG_CLOSED_EVENT } from "./MobileDialog";

export function useMobileQuickEntry() {
  const pending = useSyncExternalStore(subscribeQuickEntry, getPendingQuickEntry, getQuickEntryServerSnapshot);
  const account = useMobileAccount();
  const device = useSyncExternalStore(subscribePendingDevice, getPendingDeviceState, getPendingDeviceServerState);
  const google = useSyncExternalStore(subscribeGoogleOAuth, getGoogleOAuthState, getGoogleOAuthServerState);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (getRuntimePlatformSync() !== "android") return;
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(MOBILE_RECOVERY_CHANGED, changed);
    window.addEventListener(MOBILE_DIALOG_CLOSED_EVENT, changed);
    document.addEventListener("close", changed, true);
    return () => { window.removeEventListener(MOBILE_RECOVERY_CHANGED, changed); window.removeEventListener(MOBILE_DIALOG_CLOSED_EVENT, changed); document.removeEventListener("close", changed, true); };
  }, []);
  const ready = getRuntimePlatformSync() === "android" && account.financialReady && !account.checking && !account.error
    && !device.required && !["opening", "waiting", "processing"].includes(google.status) && !isMobileRecoveryBlocked();
  const dialogOpen = () => typeof document !== "undefined" && Boolean(document.querySelector?.('dialog[open]:not(#mobile-sidebar)'));
  return { pending, ready, revision, dialogOpen };
}

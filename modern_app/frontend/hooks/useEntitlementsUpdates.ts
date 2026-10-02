"use client";

import { useEffect } from "react";
import { getActiveOwnerId, OWNER_CHANGED_EVENT } from "../services/cloudAuth";
import { getCachedEntitlements, type BillingEntitlements } from "../services/entitlements";

// Read the owner-scoped cache already refreshed by billing; do not refetch on publication.
export function useEntitlementsUpdates(setEntitlements: (value: BillingEntitlements) => void) {
  useEffect(() => {
    const update = () => setEntitlements(getCachedEntitlements(getActiveOwnerId()));
    window.addEventListener("scisonomics:premium-entitlements-changed", update);
    window.addEventListener(OWNER_CHANGED_EVENT, update);
    return () => {
      window.removeEventListener("scisonomics:premium-entitlements-changed", update);
      window.removeEventListener(OWNER_CHANGED_EVENT, update);
    };
  }, [setEntitlements]);
}

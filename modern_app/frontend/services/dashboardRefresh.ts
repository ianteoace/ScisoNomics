import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT } from "./cloudAuth";
import { SYNC_STATE_CHANGED_EVENT, type SyncCompletedEventDetail } from "./cloudSync";

type DashboardRefreshOptions = {
  target: EventTarget;
  getOwnerId: () => string;
  onReload: (ownerId: string) => void;
  onInvalidate: (ownerChanged: boolean) => void;
  delayMs?: number;
};

export function subscribeDashboardRefresh({ target, getOwnerId, onReload, onInvalidate, delayMs = 120 }: DashboardRefreshOptions) {
  let active = true;
  let ownerId = getOwnerId();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReload = () => {
    const nextOwnerId = getOwnerId();
    const ownerChanged = nextOwnerId !== ownerId;
    ownerId = nextOwnerId;
    onInvalidate(ownerChanged);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!active) return;
      const currentOwnerId = getOwnerId();
      if (currentOwnerId !== ownerId) {
        ownerId = currentOwnerId;
        onInvalidate(true);
      }
      onReload(currentOwnerId);
    }, delayMs);
  };

  const onSyncStateChanged = (event: Event) => {
    const detail = (event as CustomEvent<SyncCompletedEventDetail>).detail;
    if (detail?.status !== "success" || detail.ownerId !== getOwnerId()) return;
    scheduleReload();
  };

  target.addEventListener(OWNER_CHANGED_EVENT, scheduleReload);
  target.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, scheduleReload);
  target.addEventListener(SYNC_STATE_CHANGED_EVENT, onSyncStateChanged);
  scheduleReload();

  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    target.removeEventListener(OWNER_CHANGED_EVENT, scheduleReload);
    target.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, scheduleReload);
    target.removeEventListener(SYNC_STATE_CHANGED_EVENT, onSyncStateChanged);
  };
}

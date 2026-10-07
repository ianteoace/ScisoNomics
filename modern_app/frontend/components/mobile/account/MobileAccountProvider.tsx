"use client";

import { DeviceVerificationDialog } from "../../account/DeviceVerificationDialog";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveAccount, getActiveCloudSession, removeAccount, CloudAuthRequestError, type StoredCloudAccount, type StoredCloudSession } from "../../../services/cloudAuth";
import { getSession, refreshSession } from "../../../services/supabaseCloudAuth";
import { loadSupabaseRefreshToken } from "../../../services/supabaseTokenStorage";

import { hasCachedDeviceGrant } from "../../../services/deviceAuthorization";
import { LOCAL_FINANCIAL_CONTEXT, resolveMobileFinancialOwner, type MobileFinancialContext } from "../../../services/data/mobileFinancialContext";

type AccountState = { financialContext: MobileFinancialContext; financialReady: boolean; financialAccount: StoredCloudAccount | null; session: StoredCloudSession | null; checking: boolean; error: string; refresh(force?: boolean): Promise<void> };
const AccountContext = createContext<AccountState>({ financialContext: LOCAL_FINANCIAL_CONTEXT, financialReady: true, financialAccount: null, session: null, checking: false, error: "", refresh: async () => {} });

export function MobileAccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredCloudSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [financialContext, setFinancialContext] = useState(LOCAL_FINANCIAL_CONTEXT);
  const [financialReady, setFinancialReady] = useState(false);
  const [financialAccount, setFinancialAccount] = useState<StoredCloudAccount | null>(null);
  const lease = useRef({ ownerId: "local", generation: 0 });
  const mounted = useRef(false);
  const request = useRef(0);
  const publish = useCallback((account: StoredCloudAccount | null, authorized: boolean) => {
    const ownerId = resolveMobileFinancialOwner(account, authorized);
    if (lease.current.ownerId !== ownerId) lease.current = { ownerId, generation: lease.current.generation + 1 };
    const generation = lease.current.generation;
    const activeId = getActiveAccount()?.user.id;
    setFinancialContext({ ownerId, isCurrent: () => lease.current.generation === generation
      && lease.current.ownerId === ownerId
      && (ownerId === "local" ? getActiveAccount()?.user.id === activeId
        : getActiveAccount()?.user.id === ownerId && hasCachedDeviceGrant(ownerId)) });
    setFinancialAccount(ownerId === "local" ? null : account);
    setFinancialReady(true);
  }, []);
  const refresh = useCallback(async (force = false) => {
    const revision = ++request.current;
    setChecking(true);
    const account = getActiveAccount();
    const current = () => mounted.current && revision === request.current && getActiveAccount()?.user.id === account?.user.id;
    if (!account) { publish(null, false); setSession(null); }
    else if (lease.current.ownerId !== account.user.id) {
      // Invalidate old editors immediately, before any native/network await.
      lease.current = { ownerId: "unresolved", generation: lease.current.generation + 1 };
      setFinancialReady(false); setSession(null); setFinancialAccount(null);
    }
    try {
      // Cached authorization + secure credential is enough to open offline SQLite.
      // This is not an online device grant: sync still validates native proof.
      if (account?.authProvider === "supabase" && hasCachedDeviceGrant(account.user.id)) {
        const available = account.storage === "persistent" ? Boolean(await loadSupabaseRefreshToken(account.user.id))
          : Boolean(getActiveCloudSession()?.user.id === account.user.id);
        if (!current()) return;
        if (available) publish(account, true);
      }
      const restored = account?.authProvider === "supabase"
        ? await (force ? refreshSession(account.user.id) : getSession(account.user.id)) : null;
      if (!current()) return;
      if (restored && restored.user.id !== account?.user.id) throw new CloudAuthRequestError(
        "La sesión no corresponde a esta cuenta. Volvé a iniciar sesión.", { code: "internal_identity_mismatch", kind: "auth" });
      if (account?.authProvider === "supabase" && account.storage === "persistent" && !restored) {
        // Android can recover an older WebView metadata snapshot after force-stop.
        // Confirm absence in authoritative secure storage; read/network failures
        // must retain the account for retry, rather than treating it as logout.
        const saved = await loadSupabaseRefreshToken(account.user.id);
        if (!mounted.current || revision !== request.current || getActiveAccount()?.user.id !== account.user.id) return;
        if (!saved) {
          await removeAccount(account.user.id);
          if (!mounted.current || revision !== request.current) return;
          publish(null, false); setSession(null); setError("");
          return;
        }
      }
      if (restored && restored.user.id === account?.user.id && hasCachedDeviceGrant(restored.user.id)) publish(restored, true);
      else if (!account || account.authProvider !== "supabase" || !hasCachedDeviceGrant(account.user.id)) publish(null, false);
      setSession(restored);
      setError(account && !restored ? "No pudimos restaurar la cuenta. Reintentá la conexión. Tus datos guardados siguen disponibles sin conexión." : "");
    } catch (failure) {
      if (!mounted.current || revision !== request.current) return;
      const active = getActiveAccount();
      const rejected = failure instanceof CloudAuthRequestError && failure.kind === "auth";
      if (!active || !hasCachedDeviceGrant(active.user.id) || rejected) publish(null, false);
      setSession(null);
      setError(rejected ? "Volvé a iniciar sesión para usar tu cuenta. Sus datos guardados se conservan por separado."
        : "No pudimos conectar la cuenta. Reintentá la conexión desde Cuenta. Tus datos guardados siguen disponibles sin conexión.");
    } finally { if (mounted.current && revision === request.current) setChecking(false); }
  }, [publish]);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const update = () => { void refresh(); };
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, update);
    window.addEventListener(OWNER_CHANGED_EVENT, update);
    return () => {
      mounted.current = false; request.current++; lease.current.generation++;
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, update);
      window.removeEventListener(OWNER_CHANGED_EVENT, update);
    };
  }, [refresh]);

  return <AccountContext.Provider value={{ financialContext, financialReady, financialAccount, session, checking, error, refresh }}><DeviceVerificationDialog />{children}</AccountContext.Provider>;
}

export const useMobileAccount = () => useContext(AccountContext);

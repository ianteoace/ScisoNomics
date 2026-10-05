"use client";

import { DeviceVerificationDialog } from "../../account/DeviceVerificationDialog";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ACCOUNT_SESSION_CHANGED_EVENT, OWNER_CHANGED_EVENT, getActiveAccount, removeAccount, type StoredCloudSession } from "../../../services/cloudAuth";
import { getSession, refreshSession } from "../../../services/supabaseCloudAuth";
import { loadSupabaseRefreshToken } from "../../../services/supabaseTokenStorage";

type AccountState = { session: StoredCloudSession | null; checking: boolean; error: string; refresh(force?: boolean): Promise<void> };
const AccountContext = createContext<AccountState>({ session: null, checking: false, error: "", refresh: async () => {} });

export function MobileAccountProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredCloudSession | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const revision = ++request.current;
    setChecking(true);
    try {
      const account = getActiveAccount();
      const restored = account?.authProvider === "supabase"
        ? await (force ? refreshSession(account.user.id) : getSession(account.user.id)) : null;
      if (!mounted.current || revision !== request.current) return;
      if (account?.authProvider === "supabase" && account.storage === "persistent" && !restored) {
        // Android can recover an older WebView metadata snapshot after force-stop.
        // Confirm absence in authoritative secure storage; read/network failures
        // must retain the account for retry, rather than treating it as logout.
        const saved = await loadSupabaseRefreshToken(account.user.id);
        if (!mounted.current || revision !== request.current || getActiveAccount()?.user.id !== account.user.id) return;
        if (!saved) {
          await removeAccount(account.user.id);
          if (!mounted.current || revision !== request.current) return;
          setSession(null); setError("");
          return;
        }
      }
      setSession(restored);
      setError(account && !restored ? "No pudimos restaurar la cuenta. Reintentá o volvé a iniciar sesión. Tus datos locales siguen disponibles." : "");
    } catch {
      if (!mounted.current || revision !== request.current) return;
      setSession(null);
      setError("No pudimos restaurar la cuenta de forma segura. Reintentá o continuá en modo local.");
    } finally { if (mounted.current && revision === request.current) setChecking(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const update = () => { void refresh(); };
    window.addEventListener(ACCOUNT_SESSION_CHANGED_EVENT, update);
    window.addEventListener(OWNER_CHANGED_EVENT, update);
    return () => {
      mounted.current = false; request.current++;
      window.removeEventListener(ACCOUNT_SESSION_CHANGED_EVENT, update);
      window.removeEventListener(OWNER_CHANGED_EVENT, update);
    };
  }, [refresh]);

  return <AccountContext.Provider value={{ session, checking, error, refresh }}><DeviceVerificationDialog />{children}</AccountContext.Provider>;
}

export const useMobileAccount = () => useContext(AccountContext);

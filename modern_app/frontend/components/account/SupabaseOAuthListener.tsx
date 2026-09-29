"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  cancelGoogleSupabaseSignIn, connectSupabaseGoogleDeepLinks, dismissGoogleOAuthNotice,
  getGoogleOAuthServerState, getGoogleOAuthState, subscribeGoogleOAuth,
} from "../../services/supabaseGoogleAuth";

// Lives outside account modals so startup callbacks and callbacks after
// navigation are handled once, including recovery from a cold launch.
export function SupabaseOAuthListener() {
  const oauth = useSyncExternalStore(subscribeGoogleOAuth, getGoogleOAuthState, getGoogleOAuthServerState);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void connectSupabaseGoogleDeepLinks().then((stop) => {
      if (cancelled) stop(); else unlisten = stop;
    }).catch(() => { /* Local mode works even when the native plugin is unavailable. */ });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  if (oauth.status === "idle") return null;
  const message = oauth.status === "opening" ? "Abriendo Google..."
    : oauth.status === "waiting" ? "Esperando confirmación de Google en el navegador..."
      : oauth.status === "processing" ? "Procesando inicio de sesión..."
        : oauth.status === "succeeded" ? "Cuenta agregada con Google mediante Supabase." : oauth.message;
  return <aside className="fixed bottom-5 right-5 z-[70] max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-100 shadow-lg">
    <p role={oauth.status === "error" ? "alert" : "status"}>{message}</p>
    {oauth.status === "waiting" ? <button className="mt-2 font-semibold text-sky-300" type="button" onClick={() => void cancelGoogleSupabaseSignIn()}>Cancelar Google</button> : null}
    {["succeeded", "error"].includes(oauth.status) ? <button className="mt-2 font-semibold text-sky-300" type="button" onClick={dismissGoogleOAuthNotice}>Cerrar aviso</button> : null}
  </aside>;
}

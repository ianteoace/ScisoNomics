"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { premiumAutoRefresh, PREMIUM_REFRESH_CHANGED_EVENT } from "../../services/premiumAutoRefresh";

export function PremiumAutoRefreshProvider() {
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    let wasVerifying = false;
    const update = () => {
      const state = premiumAutoRefresh.state();
      if (wasVerifying && state.message === "Premium activado.") toast.success(state.message);
      wasVerifying = state.verifying;
      setVerifying(state.verifying);
    };
    window.addEventListener(PREMIUM_REFRESH_CHANGED_EVENT, update);
    const detach = premiumAutoRefresh.attach(window, document);
    return () => { detach(); window.removeEventListener(PREMIUM_REFRESH_CHANGED_EVENT, update); };
  }, []);
  return verifying ? <div role="status" className="fixed bottom-4 right-4 z-50 rounded-xl border border-line bg-slate-900 px-4 py-3 text-sm text-slate-200 shadow-lg">Verificando tu pago con Mercado Pago...</div> : null;
}

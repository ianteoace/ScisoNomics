"use client";

import { useEffect } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
    try {
      window.localStorage.removeItem("theme");
      window.localStorage.removeItem("scisonomics-theme");
      window.localStorage.removeItem("next-theme");
    } catch {
      // El tema fijo no debe bloquear la app si localStorage no esta disponible.
    }
  }, []);

  return <>{children}</>;
}

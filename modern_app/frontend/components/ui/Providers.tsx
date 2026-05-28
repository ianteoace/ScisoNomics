"use client";

import { useEffect } from "react";
import { ThemeProvider } from "next-themes";

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

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" enableSystem={false} disableTransitionOnChange>
      {children}
    </ThemeProvider>
  );
}

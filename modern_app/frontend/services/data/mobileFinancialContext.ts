import type { StoredCloudAccount } from "../cloudAuth";

export type MobileFinancialContext = { ownerId: string; isCurrent(): boolean };
export const LOCAL_FINANCIAL_CONTEXT: MobileFinancialContext = { ownerId: "local", isCurrent: () => true };

// Authorization is supplied by the account provider, never inferred from email/sub.
// A cached grant permits offline SQLite use; it does not authorize cloud requests.
export function resolveMobileFinancialOwner(account: StoredCloudAccount | null, authorized: boolean): string {
  const id = account?.user.id;
  return authorized && account?.authProvider === "supabase" && id && id !== "local"
    && /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : "local";
}

export function assertFinancialContext(context: MobileFinancialContext) {
  if (!context.isCurrent()) throw new Error("La cuenta activa cambió. Volvé a abrir el formulario.");
}

import { getRuntimePlatformSync } from "../platform";
import type { FinanceRepository } from "./financeRepositoryTypes";

export async function getFinanceRepository(): Promise<FinanceRepository> {
  const platform = getRuntimePlatformSync();
  if (platform === "android" || platform === "ios") {
    return (await import("./mobileFinanceRepository")).mobileFinanceRepository;
  }
  return (await import("./desktopFinanceRepository")).desktopFinanceRepository;
}

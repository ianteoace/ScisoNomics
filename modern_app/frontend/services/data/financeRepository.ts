import { getRuntimePlatformSync } from "../platform";
import type { FinanceRepository } from "./financeRepositoryTypes";

const alwaysCurrent = () => true;
export async function getFinanceRepository(ownerId = "local", isCurrent: () => boolean = alwaysCurrent): Promise<FinanceRepository> {
  const platform = getRuntimePlatformSync();
  if (platform === "android" || platform === "ios") {
    const module = await import("./mobileFinanceRepository");
    return ownerId === "local" && isCurrent === alwaysCurrent ? module.mobileFinanceRepository
      : module.createMobileFinanceRepository(ownerId, isCurrent);
  }
  return (await import("./desktopFinanceRepository")).desktopFinanceRepository;
}

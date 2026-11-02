// Development-only setup/observation of disposable origin-private data.
import { RealFileSystemAdapter } from "../src/engine/fs-adapter";
import { changeCaseLifecycle } from "../src/engine/case-lifecycle-service";
import { openExistingVault } from "../src/engine/vault-service";
import { comparisonFixtureFingerprint } from "./comparison-seed";
import { seedApplyPreviewReview } from "./apply-preview-seed";

export async function seedCaseActivityReview() {
  if (!import.meta.env.DEV) throw new Error("Development fixture only");
  const fixture = await seedApplyPreviewReview();
  if (!fixture.vaultPath) throw new Error("Fixture vault path unavailable");
  const storage = await navigator.storage.getDirectory();
  const root = new RealFileSystemAdapter(
    await storage.getDirectoryHandle(fixture.rootName),
  );
  const vault = await root.getDirectory(fixture.vaultPath);
  const state = await openExistingVault(vault);
  const workingFolders = Object.fromEntries(
    await Promise.all(
      Object.entries(fixture.workingPaths).map(async ([id, path]) => [
        id,
        await root.getDirectory(path as string[]),
      ]),
    ),
  );
  await changeCaseLifecycle(
    vault,
    {
      projectId: state.project.projectId,
      branchId: fixture.safeCaseId,
      activeBranchId: "branch-main",
      status: "archived",
      expectedVersion: null,
    },
    { workingFolders },
  );
  return {
    ...fixture,
    fingerprint: await comparisonFixtureFingerprint(fixture.rootName),
    caseSavedAt: state.revisions.find(
      (r) => r.manifest.revisionId === fixture.ids[2],
    )!.manifest.captureCompletedAt,
  };
}

let stopObservation: (() => Record<string, number>) | undefined;
export function observeCaseActivityStorage() {
  if (!import.meta.env.DEV) throw new Error("Development observation only");
  if (stopObservation) throw new Error("Observation already active");
  const calls: Record<string, number> = {};
  const prototype = RealFileSystemAdapter.prototype;
  const originals = new Map<string, PropertyDescriptor>();
  for (const name of [
    "listEntries",
    "readFileBytes",
    "readFileText",
    "readFileStream",
    "writeFileBytes",
    "writeFileText",
    "writeFileStream",
    "removeEntry",
    "getDirectory",
    "queryPermission",
    "requestPermission",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    originals.set(name, descriptor);
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: function (this: RealFileSystemAdapter, ...args: unknown[]) {
        calls[name] = (calls[name] ?? 0) + 1;
        return descriptor.value.apply(this, args);
      },
    });
  }
  stopObservation = () => {
    for (const [name, descriptor] of originals)
      Object.defineProperty(prototype, name, descriptor);
    stopObservation = undefined;
    return calls;
  };
}
export function finishCaseActivityObservation() {
  if (!stopObservation) throw new Error("No active observation");
  return stopObservation();
}

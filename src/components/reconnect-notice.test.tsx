import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useOperation } from "../app/useOperation";
import { AppNotices, type AppNoticesProps } from "../app/AppNotices";
import { FolderAccessError, isFolderAccessError } from "../utils/folder-access";
import type { StatusBanner } from "../app/types";

afterEach(cleanup);

async function bannerAfter(thrown: unknown): Promise<StatusBanner | null> {
  const { result } = renderHook(() => useOperation({ activeTab: "changes" }));
  await act(async () => {
    await result.current.perform("connect", async () => {
      throw thrown;
    });
  });
  return result.current.statusBanner;
}

function notices(statusBanner: StatusBanner) {
  const props: AppNoticesProps = {
    progress: null,
    isVerifyingAll: false,
    isScanning: false,
    activeTab: "changes",
    statusBanner,
    setStatusBanner: () => {},
    bannerScope: "project",
    projectView: true,
    busy: false,
    vaultState: null,
    managedBlockReason: undefined,
    missingConnections: [],
    navigate: () => {},
    onCancelOperation: () => {},
    onReattachWorkingFolder: () => {},
  };
  return render(<AppNotices {...props} />);
}
const RECONNECT = { name: "Reconnect workspace" };

test("a browser permission error (NotAllowedError) offers Reconnect workspace", async () => {
  const banner = await bannerAfter(new DOMException("The user denied it.", "NotAllowedError"));
  assert.equal(banner?.type, "error");
  assert.equal(banner?.reconnect, true);
  assert.ok(notices(banner!).getByRole("button", RECONNECT));
});

test("a SecurityError and a FolderAccessError offer Reconnect workspace too, even when the wording has none of the old keywords", async () => {
  assert.equal((await bannerAfter(new DOMException("Blocked.", "SecurityError")))?.reconnect, true);
  const banner = await bannerAfter(new FolderAccessError("Something about this folder."));
  assert.equal(banner?.reconnect, true);
  assert.ok(notices(banner!).getByRole("button", RECONNECT));
});

test("an unrelated error whose text merely contains access, permission or reconnect does not offer Reconnect workspace", async () => {
  for (const message of ["Cannot access the reference number.", "Permission slips are due.", "Please reconnect your thoughts."]) {
    const banner = await bannerAfter(new Error(message));
    assert.equal(banner?.type, "error");
    assert.equal(banner?.reconnect, undefined);
    assert.equal(notices(banner!).queryByRole("button", RECONNECT), null);
    cleanup();
  }
});

test("isFolderAccessError looks through a wrapped cause but not a plain message", () => {
  assert.equal(isFolderAccessError(new Error("outer", { cause: new DOMException("x", "NotAllowedError") })), true);
  assert.equal(isFolderAccessError(new Error("access permission reconnect")), false);
  assert.equal(isFolderAccessError(undefined), false);
});

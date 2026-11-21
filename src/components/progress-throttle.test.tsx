import "../../tests/dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useOperation } from "../app/useOperation";
import type { ProgressUpdate } from "../engine/types";

afterEach(cleanup);

const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const update = (processedFiles: number, phase: ProgressUpdate["phase"] = "writing_objects"): ProgressUpdate => ({
  phase,
  processedFiles,
  totalFiles: 1000,
  processedBytes: 0,
  totalBytes: 0,
  message: `file ${processedFiles}`,
});

function setup() {
  const renders = { count: 0 };
  const hook = renderHook(() => {
    renders.count++;
    return useOperation({ activeTab: "changes" });
  });
  return { ...hook, renders };
}

/** Starts an operation that the test finishes by calling `finish()`. */
function startHeld(result: ReturnType<typeof setup>["result"], report: (progress: (p: ProgressUpdate) => void) => void) {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let done!: Promise<unknown>;
  act(() => {
    done = result.current.perform("capture", async (context) => {
      report(context.progress);
      await held;
    });
  });
  return { finish: () => act(async () => { finish(); await done; }) };
}

test("1,000 progress calls in one operation cause a handful of renders, and the latest value lands", async () => {
  const { result, renders } = setup();
  let before = 0;
  const op = startHeld(result, (progress) => {
    before = renders.count;
    for (let i = 1; i <= 1000; i++) progress(update(i));
  });
  assert.equal(result.current.progress?.processedFiles, 1, "the first update shows at once");
  await sleep(250);
  assert.equal(result.current.progress?.processedFiles, 1000, "the latest update lands after the interval");
  assert.ok(renders.count - before <= 5, `expected only a few renders, got ${renders.count - before}`);
  await op.finish();
});

test("a phase change shows immediately", async () => {
  const { result } = setup();
  const op = startHeld(result, (progress) => {
    progress(update(1));
    progress(update(2));
    progress(update(3, "verifying_objects"));
  });
  assert.equal(result.current.progress?.phase, "verifying_objects");
  assert.equal(result.current.progress?.processedFiles, 3);
  await op.finish();
});

test("after the operation finishes, progress is null and no late flush follows", async () => {
  const { result } = setup();
  const op = startHeld(result, (progress) => {
    progress(update(1));
    progress(update(2));
  });
  assert.equal(result.current.progress?.processedFiles, 1);
  await op.finish();
  assert.equal(result.current.progress, null);
  await sleep(250);
  assert.equal(result.current.progress, null);
});

test("progress from a finished or replaced operation does not land", async () => {
  const { result } = setup();
  let stale!: (p: ProgressUpdate) => void;
  const shown = () => result.current.progress;
  const first = startHeld(result, (progress) => { stale = progress; progress(update(1)); progress(update(2)); });
  await first.finish();
  assert.equal(shown(), null);
  const second = startHeld(result, (progress) => progress(update(7, "restoring_files")));
  act(() => stale(update(999, "restoring_files")));
  act(() => stale(update(998, "scanning_source")));
  await sleep(250);
  assert.equal(shown()?.processedFiles, 7, "the new operation's progress is untouched");
  await second.finish();
  act(() => stale(update(997)));
  await sleep(250);
  assert.equal(shown(), null);
});

test("a cancelled operation leaves no pending progress behind", async () => {
  const { result } = setup();
  let abortSeen!: () => void;
  const aborted = new Promise<void>((resolve) => { abortSeen = resolve; });
  let done!: Promise<unknown>;
  act(() => {
    done = result.current.perform("capture", async (context) => {
      context.signal.addEventListener("abort", () => abortSeen());
      context.progress(update(1));
      context.progress(update(2));
      await aborted;
      throw new DOMException("Cancelled", "AbortError");
    });
  });
  act(() => result.current.handleCancelOperation());
  await act(async () => { await done; });
  await sleep(250);
  assert.equal(result.current.progress, null);
  assert.equal(result.current.operation, null);
});

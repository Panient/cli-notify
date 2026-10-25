"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compareEventsByCompletion,
  createPendingNotification,
  buildNotificationPresentation,
  resolvePendingNotifications,
  visibleNotifications,
} = require("../src/notification-state");

function pending(source, handle, options = {}) {
  const notification = createPendingNotification({
    source,
    windowHandle: handle,
    windowProcessId: options.processId ?? handle,
    windowProcessStartTicks: options.startTicks || String(1000 + handle),
    createdAt: options.createdAt ?? handle,
    aborted: options.aborted,
  }, 10000, 1800000);
  // Presentation tests model terminals the user has left. Dedicated tests
  // below override this to cover active-terminal deferral and expiry.
  notification.leftTerminal = options.leftTerminal ?? true;
  return notification;
}

function windowSnapshot(notifications, foreground = 999) {
  return {
    foreground: { root: foreground, processId: foreground, startTicks: String(1000 + foreground) },
    windows: new Map(notifications.map((n) => [n.windowHandle, {
      root: n.windowHandle,
      processId: n.windowProcessId,
      startTicks: n.windowProcessStartTicks,
    }])),
  };
}

test("same-platform terminals stay separate and show a grouped count", () => {
  const notifications = [pending("Codex", 101), pending("Codex", 102), pending("Codex", 103)];
  const view = buildNotificationPresentation(notifications);
  assert.equal(view.source, "code CLI");
  assert.equal(view.count, 3);
  assert.deepEqual(view.sources, [{ label: "code CLI", count: 3 }]);
  assert.equal(view.aborted, false);
});

test("different platforms share one presentation without losing any source", () => {
  const notifications = [pending("Codex", 101), pending("Claude", 102), pending("Pi", 103)];
  const view = buildNotificationPresentation(notifications);
  assert.equal(view.source, "Pi");
  assert.equal(view.count, 3);
  assert.deepEqual(view.sources, [
    { label: "code CLI", count: 1 },
    { label: "Claude Code", count: 1 },
    { label: "Pi", count: 1 },
  ]);
});

test("completion timestamps, not random queue filenames, select the latest event", () => {
  const files = ["dcef.json", "aaaa.json", "9230.json"];
  const events = [
    { source: "Pi", createdAt: 300 },
    { source: "Codex", createdAt: 100 },
    { source: "Claude", createdAt: 200 },
  ];
  files.map((_, index) => events[index]).sort(compareEventsByCompletion);
  const ordered = events.sort(compareEventsByCompletion);
  assert.equal(buildNotificationPresentation(ordered.map((event, index) =>
    pending(event.source, 100 + index, { createdAt: event.createdAt })
  )).source, "Pi");
});

test("mixed complete and interrupted events summarize accurately", () => {
  const view = buildNotificationPresentation([
    pending("Codex", 101),
    pending("Claude", 102, { aborted: true }),
    pending("Pi", 103, { aborted: true }),
  ]);
  assert.equal(view.count, 3);
  assert.equal(view.source, "Pi");
  assert.equal(view.aborted, true);
  assert.equal(view.message, "本次运行已停止");
  assert.deepEqual(view.sources, [
    { label: "code CLI", count: 1 },
    { label: "Claude Code", count: 1 },
    { label: "Pi", count: 1 },
  ]);
});

test("returning to one terminal only resolves that terminal's tasks", () => {
  const all = [pending("Codex", 101), pending("Codex", 102), pending("Claude", 103)];
  for (const notification of all) notification.leftTerminal = true;
  const result = resolvePendingNotifications(all, new Set(all), windowSnapshot(all, 102), 11000);
  assert.deepEqual(result.pending.map((n) => n.windowHandle), [101, 103]);
  const view = buildNotificationPresentation(result.pending);
  assert.equal(view.count, 2);
  assert.deepEqual(view.sources, [
    { label: "code CLI", count: 1 },
    { label: "Claude Code", count: 1 },
  ]);
});

test("a foreground terminal waits until the user leaves before showing", () => {
  const notification = pending("Codex", 101, { leftTerminal: false });
  assert.equal(buildNotificationPresentation([notification]), null);
  const snapshot = windowSnapshot([notification], 101);
  resolvePendingNotifications([notification], new Set([notification]), snapshot, 11000);
  assert.equal(buildNotificationPresentation([notification]), null);
  snapshot.foreground = { root: 202, processId: 202, startTicks: "1202" };
  resolvePendingNotifications([notification], new Set([notification]), snapshot, 11001);
  assert.equal(visibleNotifications([notification]).length, 1);
  assert.equal(buildNotificationPresentation([notification]).source, "code CLI");
});

test("returning to the foreground terminal clears only its visible task", () => {
  const notification = pending("Codex", 101);
  notification.leftTerminal = true;
  assert.equal(buildNotificationPresentation([notification]).count, 1);
  const snapshot = windowSnapshot([notification], 101);
  const result = resolvePendingNotifications([notification], new Set([notification]), snapshot, 11000);
  assert.equal(result.pending.length, 0);
});

test("a newly arrived event is not cleared by an older in-flight window query", () => {
  const original = pending("Codex", 101);
  const addedDuringQuery = pending("Pi", 102);
  const result = resolvePendingNotifications(
    [original, addedDuringQuery],
    new Set([original]),
    windowSnapshot([original]),
    11000,
  );
  assert.deepEqual(result.pending, [original, addedDuringQuery]);
});

test("recycled or closed terminal handles resolve their notifications", () => {
  const all = [pending("Codex", 101), pending("Pi", 102), pending("Claude", 103)];
  const snapshot = windowSnapshot(all);
  snapshot.windows.delete(101);
  snapshot.windows.get(102).startTicks = "different-process";
  const result = resolvePendingNotifications(all, new Set(all), snapshot, 11000);
  assert.deepEqual(result.pending.map((n) => n.source), ["Claude"]);
});

test("malformed window identity uses only bounded fallback expiry", () => {
  const notification = pending("Codex", 101, { processId: 0 });
  assert.equal(notification.windowHandle, 0);
  const empty = { foreground: { root: 0 }, windows: new Map() };
  assert.equal(resolvePendingNotifications([notification], new Set([notification]), empty, 11000).pending.length, 1);
  assert.equal(resolvePendingNotifications([notification], new Set([notification]), empty, notification.fallbackExpiry).pending.length, 0);
});

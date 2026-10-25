"use strict";

// Pure notification state shared by the Electron process and its tests. Each
// entry represents one completed terminal turn, not merely one CLI platform.
const SOURCE_LABELS = Object.freeze({
  Codex: "code CLI",
  Claude: "Claude Code",
  Gemini: "Gemini CLI",
  GrokBuild: "Grok Build",
  OpenCode: "OpenCode",
  Pi: "Pi",
});

function displaySource(source) {
  return SOURCE_LABELS[source] || source || "AI CLI";
}

function eventCompletionTime(event) {
  const value = Number(event && event.createdAt);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function compareEventsByCompletion(a, b) {
  return eventCompletionTime(a) - eventCompletionTime(b);
}

function createPendingNotification(event, now, fallbackExpireMs) {
  const windowHandle = Number(event.windowHandle);
  const windowProcessId = Number(event.windowProcessId);
  const windowProcessStartTicks = String(event.windowProcessStartTicks || "");
  const hasWindowIdentity = Number.isSafeInteger(windowHandle) && windowHandle > 0 &&
    Number.isSafeInteger(windowProcessId) && windowProcessId > 0 &&
    /^\d+$/.test(windowProcessStartTicks) && /[1-9]/.test(windowProcessStartTicks);
  return {
    windowHandle: hasWindowIdentity ? windowHandle : 0,
    windowProcessId: hasWindowIdentity ? windowProcessId : 0,
    windowProcessStartTicks: hasWindowIdentity ? windowProcessStartTicks : "",
    source: event.source,
    aborted: event.aborted === true,
    cwd: event.cwd || "",
    createdAt: eventCompletionTime(event),
    leftTerminal: false,
    fallbackExpiry: now + fallbackExpireMs,
  };
}

function visibleNotifications(pending) {
  // If a terminal is still active, wait until the user leaves it. Unknown
  // terminals retain the immediate notification and bounded fallback expiry.
  return pending.filter((notification) => notification.windowHandle === 0 || notification.leftTerminal);
}

function summarizeNotifications(pending) {
  const groups = new Map();
  for (const notification of pending) {
    const label = displaySource(notification.source);
    const existing = groups.get(label);
    if (existing) existing.count++;
    else groups.set(label, { label, count: 1 });
  }
  return [...groups.values()];
}

function buildNotificationPresentation(pending) {
  const visible = visibleNotifications(pending);
  if (visible.length === 0) return null;
  const latest = visible[visible.length - 1];
  const aborted = latest.aborted === true;
  return {
    source: displaySource(latest.source),
    aborted,
    message: aborted ? "本次运行已停止" : "任务已经完成，辛苦了",
    count: visible.length,
    sources: summarizeNotifications(visible),
  };
}

function resolvePendingNotifications(pending, queried, result, now) {
  const { foreground, windows } = result;
  const keep = [];
  for (const notification of pending) {
    // Events can arrive while the native window query is in flight. Do not
    // judge those entries using a snapshot that did not include their handle.
    if (!queried.has(notification)) {
      keep.push(notification);
      continue;
    }
    if (notification.windowHandle <= 0) {
      if (now < notification.fallbackExpiry) keep.push(notification);
      continue;
    }

    const terminal = windows.get(notification.windowHandle);
    // Reject closed windows, recycled handles, and replaced owner processes.
    if (!terminal || Number(terminal.root) !== notification.windowHandle) continue;
    if (Number(terminal.processId) !== notification.windowProcessId) continue;
    if (String(terminal.startTicks) !== notification.windowProcessStartTicks) continue;

    const sameTerminal = Number(foreground.root) === notification.windowHandle &&
      Number(foreground.processId) === notification.windowProcessId &&
      String(foreground.startTicks) === notification.windowProcessStartTicks;
    // Returning to a terminal only clears that terminal's completed turns.
    if (notification.leftTerminal && sameTerminal) continue;
    if (Number(foreground.root) > 0 && !sameTerminal) notification.leftTerminal = true;
    keep.push(notification);
  }
  return { pending: keep, changed: keep.length !== pending.length };
}

module.exports = {
  displaySource,
  compareEventsByCompletion,
  createPendingNotification,
  visibleNotifications,
  summarizeNotifications,
  buildNotificationPresentation,
  resolvePendingNotifications,
};

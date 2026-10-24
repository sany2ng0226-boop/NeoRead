// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderChrome, interactionOpen } from "./reader-chrome";

let held = false;
let chrome: ReaderChrome;
const shown: boolean[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  held = false;
  shown.length = 0;
  chrome = new ReaderChrome(
    (visible) => shown.push(visible),
    () => held,
    3000,
  );
});
afterEach(() => {
  chrome.dispose();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

it("fades after an idle moment and at once when reading moves on", () => {
  vi.advanceTimersByTime(2999);
  expect(chrome.visible).toBe(true);
  vi.advanceTimersByTime(1);
  expect(chrome.visible).toBe(false);
  chrome.reveal();
  expect(chrome.visible).toBe(true);
  chrome.read();
  expect(shown).toEqual([false, true, false]);
});

it("stays while the pointer is on it or keyboard focus is inside", () => {
  chrome.read();
  chrome.pointerEnter();
  expect(chrome.visible).toBe(true);
  vi.advanceTimersByTime(10_000);
  expect(chrome.visible).toBe(true);
  chrome.pointerLeave();
  vi.advanceTimersByTime(3000);
  expect(chrome.visible).toBe(false);
  // Reading means the pointer is with the text, even without a leave event.
  chrome.pointerEnter();
  chrome.read();
  expect(chrome.visible).toBe(false);
  expect(chrome.hovered).toBe(false);

  chrome.focusIn();
  vi.advanceTimersByTime(10_000);
  chrome.read();
  expect(chrome.visible).toBe(true);
  chrome.focusOut();
  vi.advanceTimersByTime(3000);
  expect(chrome.visible).toBe(false);
});

it("waits for selections, menus and typing to finish before fading", () => {
  held = true;
  chrome.read();
  vi.advanceTimersByTime(9000);
  expect(chrome.visible).toBe(true);
  held = false;
  vi.advanceTimersByTime(3000);
  expect(chrome.visible).toBe(false);
});

it("keeps a toolbar brought back on purpose until reading resumes", () => {
  chrome.read();
  chrome.reveal(true);
  vi.advanceTimersByTime(60_000);
  expect(chrome.visible).toBe(true);
  chrome.read();
  expect(chrome.visible).toBe(false);
});

it("treats typing and open popups as interactions, not plain buttons", () => {
  const button = document.createElement("button");
  const area = document.createElement("textarea");
  document.body.append(button, area);
  button.focus();
  expect(interactionOpen()).toBe(false);
  area.focus();
  expect(interactionOpen()).toBe(true);
  button.focus();
  button.setAttribute("data-popup-open", "");
  expect(interactionOpen()).toBe(true);
  button.removeAttribute("data-popup-open");
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  expect(interactionOpen()).toBe(true);
});

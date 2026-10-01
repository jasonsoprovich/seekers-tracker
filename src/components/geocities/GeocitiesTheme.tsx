"use client";

import { useEffect, useLayoutEffect, useState } from "react";

const GEOCITIES_STORAGE_KEY = "seekers-geocities";
import "./geocities.css";

// Joke "GeoCities 1997" skin. Purely presentational: toggled by the Konami
// code, stored in localStorage, and expressed as a single attribute on <html>
// (data-theme="geocities") that every rule in geocities.css is scoped under.
// With the attribute absent nothing here is visible or loaded (all art is CSS
// background-images that only exist under that selector).

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
const VIEWS_KEY = "seekers-geocities-views";
const SEED_VISITORS = 420;

function setActive(on: boolean) {
  const root = document.documentElement;
  if (on) root.setAttribute("data-theme", "geocities");
  else root.removeAttribute("data-theme");
}

function readStored(): boolean {
  try {
    return localStorage.getItem(GEOCITIES_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeStored(on: boolean) {
  try {
    if (on) localStorage.setItem(GEOCITIES_STORAGE_KEY, "on");
    else localStorage.removeItem(GEOCITIES_STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode); the theme still works for this page view.
  }
}

// Fake hit counter: a fixed seed plus this browser's own page views. No network.
function bumpVisitors(): number {
  let views = 0;
  try {
    views = Number(localStorage.getItem(VIEWS_KEY)) || 0;
    views += 1;
    localStorage.setItem(VIEWS_KEY, String(views));
  } catch {
    views = 1;
  }
  return SEED_VISITORS + views;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function GeocitiesTheme() {
  const [visitors, setVisitors] = useState(SEED_VISITORS);

  // Re-apply the saved preference before paint. (No inline <script>: React warns about
  // script tags rendered inside components on client navigations.)
  useLayoutEffect(() => {
    const initial = readStored();
    setActive(initial);
    if (initial) setVisitors(bumpVisitors());
  }, []);

  useEffect(() => {

    let progress = 0;
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        progress = 0;
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === KONAMI[progress]) progress += 1;
      else progress = key === KONAMI[0] ? 1 : 0;
      if (progress === KONAMI.length) {
        progress = 0;
        const next = !readStored();
        writeStored(next);
        setActive(next);
        if (next) setVisitors(bumpVisitors());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      // Leaving the (app) section (e.g. to /login) always shows the normal theme;
      // the saved preference stays for when the member comes back.
      document.documentElement.removeAttribute("data-theme");
    };
  }, []);

  function exit() {
    writeStored(false);
    setActive(false);
  }

  const digits = String(visitors).padStart(6, "0").split("");

  return (
    <>
      <div className="gc-decor">
        <div className="gc-banner">
          <div className="gc-globe" aria-hidden="true" />
          <div className="gc-counter" aria-hidden="true">
            <span className="gc-odo">
              {digits.map((d, i) => (
                <i key={i}>{d}</i>
              ))}
            </span>
            <em>Visitors Since 1997!</em>
          </div>
          <div className="gc-fairy" aria-hidden="true" />
          <div className="gc-title" aria-hidden="true">
            <span>Seekers of Souls</span>
          </div>
          <div className="gc-sword" aria-hidden="true" />
          <div className="gc-tagline" aria-hidden="true">A World of Warriors, Friends &amp; Fun!</div>
          <div className="gc-castle" aria-hidden="true" />
          <div className="gc-dragon" aria-hidden="true" />
          <div className="gc-welcome" aria-hidden="true">Welcome to our Guild!</div>
          <div className="gc-flames" aria-hidden="true" />
          <button type="button" className="gc-exit" onClick={exit}>
            Exit 1997 mode
          </button>
        </div>
        <div className="gc-rail" aria-hidden="true">
          <div className="gc-knight">
            <span>EPGP 4 LYFE!!!</span>
          </div>
          <div className="gc-box gc-construction" />
          <div className="gc-box gc-bestguild" />
          <div className="gc-box gc-raid" />
          <div className="gc-box gc-favorites" />
          <div className="gc-box gc-netscape" />
        </div>
      </div>
    </>
  );
}

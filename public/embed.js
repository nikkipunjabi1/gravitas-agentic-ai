/* =============================================================================
 * Gravitas Co-Pilot — embeddable chat widget
 *
 * Drop this single line into any page on thisisgravitas.com (or any site):
 *
 *   <script src="https://ai.thisisgravitas.com/embed.js" async></script>
 *
 * Floating launcher in the bottom-right corner. Clicking opens an iframe
 * panel pointing at /copilot?embed=1. The iframe source must be served from
 * the same origin as this script (we derive it from the <script> src).
 *
 * No dependencies. ~3 KB minified. Idempotent — safe to load more than once.
 *
 * Customisation (set BEFORE the script tag executes):
 *
 *   <script>
 *     window.GravitasCopilot = {
 *       position: 'bottom-right' | 'bottom-left',   // default bottom-right
 *       primaryColor: '#0B0B0F',                    // launcher background
 *       launcherText: 'Talk to us',                  // label shown beside icon
 *       width: 400, height: 600,                    // panel size (px)
 *     };
 *   </script>
 *   <script src="https://ai.thisisgravitas.com/embed.js" async></script>
 *
 * ========================================================================== */

(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__gravitasCopilotEmbedLoaded) return;
  window.__gravitasCopilotEmbedLoaded = true;

  // ---- Resolve our origin from the current <script> src ------------------
  // Works whether the script is loaded sync or async. Falls back to the
  // window origin (covers the case where document.currentScript is null,
  // e.g. when the script is injected at runtime).
  var origin = (function () {
    var current = document.currentScript;
    if (current && current.src) {
      try {
        return new URL(current.src, location.href).origin;
      } catch (_) {
        /* fall through */
      }
    }
    return window.location.origin;
  })();

  var userConfig = window.GravitasCopilot || {};
  var config = {
    position: userConfig.position || "bottom-right",
    primaryColor: userConfig.primaryColor || "#0B0B0F",
    launcherText: userConfig.launcherText || "",
    width: userConfig.width || 400,
    height: userConfig.height || 600,
  };

  var embedUrl = origin + "/copilot?embed=1";

  // ---- Styles -------------------------------------------------------------
  var positionCss =
    config.position === "bottom-left"
      ? "left: 24px;"
      : "right: 24px;";

  var css = [
    ".gv-launcher {",
    "  position: fixed; bottom: 24px; " + positionCss,
    "  display: inline-flex; align-items: center; gap: 8px;",
    "  padding: 0 18px; height: 56px;",
    "  border: none; border-radius: 28px;",
    "  background: " + config.primaryColor + "; color: #FAFAF7;",
    "  box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);",
    "  font: 500 14px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
    "  cursor: pointer; z-index: 2147483646;",
    "  transition: transform 0.18s ease, box-shadow 0.18s ease;",
    "}",
    ".gv-launcher:hover { transform: translateY(-1px); box-shadow: 0 12px 36px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.1); }",
    ".gv-launcher:focus { outline: 2px solid rgba(233,78,27,0.6); outline-offset: 2px; }",
    ".gv-launcher svg { width: 22px; height: 22px; }",
    ".gv-launcher span { white-space: nowrap; }",
    ".gv-launcher--open { transform: scale(0.92); }",
    "",
    ".gv-panel {",
    "  position: fixed; bottom: 96px; " + positionCss,
    "  width: " + config.width + "px; height: " + config.height + "px;",
    "  max-width: calc(100vw - 48px); max-height: calc(100vh - 120px);",
    "  background: #FAFAF7; border-radius: 16px; overflow: hidden;",
    "  box-shadow: 0 24px 64px rgba(0,0,0,0.24), 0 8px 24px rgba(0,0,0,0.12);",
    "  z-index: 2147483645; display: none;",
    "  transform-origin: bottom " + (config.position === "bottom-left" ? "left" : "right") + ";",
    "}",
    ".gv-panel.gv-open { display: block; animation: gv-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }",
    "@keyframes gv-in { from { opacity: 0; transform: translateY(12px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }",
    ".gv-panel iframe { width: 100%; height: 100%; border: 0; display: block; }",
    "",
    ".gv-close {",
    "  position: absolute; top: 10px; " + (config.position === "bottom-left" ? "right: 10px;" : "right: 10px;"),
    "  width: 28px; height: 28px; border: none; border-radius: 14px;",
    "  background: rgba(11,11,15,0.78); color: #FAFAF7;",
    "  font: 600 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
    "  cursor: pointer; z-index: 1;",
    "  display: flex; align-items: center; justify-content: center;",
    "  transition: background 0.15s ease;",
    "}",
    ".gv-close:hover { background: rgba(11,11,15,0.92); }",
    "",
    "@media (max-width: 640px) {",
    "  .gv-panel { right: 12px !important; left: 12px !important; bottom: 80px;",
    "              width: auto !important; max-width: none !important; height: calc(100vh - 100px); }",
    "  .gv-launcher { right: 16px !important; left: auto !important; bottom: 16px; }",
    "}",
  ].join("\n");

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- Launcher button ----------------------------------------------------
  var launcher = document.createElement("button");
  launcher.className = "gv-launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open Gravitas Co-Pilot");
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML =
    '<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.84L3 21l1.84-5C3.32 14.62 3 13.34 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>' +
    "</svg>" +
    (config.launcherText ? '<span>' + escapeHtml(config.launcherText) + "</span>" : "");

  // ---- Panel + iframe (lazy — only created on first open) ----------------
  var panel = null;
  var iframe = null;

  function openPanel() {
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "gv-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Gravitas Co-Pilot");

      iframe = document.createElement("iframe");
      iframe.src = embedUrl;
      iframe.title = "Gravitas Co-Pilot";
      iframe.allow = "clipboard-write";
      iframe.setAttribute("loading", "lazy");

      var close = document.createElement("button");
      close.type = "button";
      close.className = "gv-close";
      close.setAttribute("aria-label", "Close Gravitas Co-Pilot");
      close.innerHTML = "×"; // ×
      close.addEventListener("click", closePanel);

      panel.appendChild(close);
      panel.appendChild(iframe);
      document.body.appendChild(panel);
    }
    panel.classList.add("gv-open");
    launcher.classList.add("gv-launcher--open");
    launcher.setAttribute("aria-expanded", "true");
  }

  function closePanel() {
    if (panel) panel.classList.remove("gv-open");
    launcher.classList.remove("gv-launcher--open");
    launcher.setAttribute("aria-expanded", "false");
  }

  function togglePanel() {
    if (panel && panel.classList.contains("gv-open")) {
      closePanel();
    } else {
      openPanel();
    }
  }

  launcher.addEventListener("click", togglePanel);

  // ---- Mount when DOM is ready -------------------------------------------
  if (document.body) {
    document.body.appendChild(launcher);
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      document.body.appendChild(launcher);
    });
  }

  // ---- Programmatic API (window.GravitasCopilot.open() / .close()) -------
  window.GravitasCopilot = Object.assign(window.GravitasCopilot || {}, {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
  });

  // ---- helpers -----------------------------------------------------------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();

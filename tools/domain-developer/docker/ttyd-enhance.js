/*
 * domain-developer — in-terminal enhancements injected into ttyd's page.
 *
 * Injected at the very top of <head> (before ttyd's own bundle) so it can wrap
 * window.WebSocket before ttyd opens its socket.
 *
 *  1. Shift+Enter = newline (ESC+CR on the websocket).
 *  2. Redraw / repaint (clear xterm glyph atlas via postMessage from panel).
 *  3. Drag-to-select + auto-copy (bypass tmux mouse mode for left-button drags).
 *  4. Suppress browser context menu on the terminal.
 */
(function () {
  'use strict';

  // ── Shared helper ───────────────────────────────────────────────────────
  function inTerm(el) {
    var s = document.querySelector('.xterm-screen');
    return s && s.contains(el);
  }

  // ── 1. Shift+Enter → ESC+CR ────────────────────────────────────────────
  var Native = window.WebSocket;
  var activeSocket = null;

  function PatchedWebSocket(url, protocols) {
    var ws = (protocols === undefined)
      ? new Native(url)
      : new Native(url, protocols);
    activeSocket = ws;
    return ws;
  }
  PatchedWebSocket.prototype = Native.prototype;
  PatchedWebSocket.CONNECTING = Native.CONNECTING;
  PatchedWebSocket.OPEN = Native.OPEN;
  PatchedWebSocket.CLOSING = Native.CLOSING;
  PatchedWebSocket.CLOSED = Native.CLOSED;
  window.WebSocket = PatchedWebSocket;

  var NEWLINE_FRAME = new Uint8Array([0x30, 0x1b, 0x0d]);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.shiftKey &&
        !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (activeSocket && activeSocket.readyState === Native.OPEN) {
        e.preventDefault();
        e.stopImmediatePropagation();
        activeSocket.send(NEWLINE_FRAME);
      }
    }
  }, true);

  // ── 2. Redraw: clear the glyph atlas + full refresh ─────────────────────
  function redraw() {
    var t = window.term;
    if (!t) return;
    try { if (typeof t.clearTextureAtlas === 'function') t.clearTextureAtlas(); } catch (e) {}
    try { if (typeof t.refresh === 'function') t.refresh(0, (t.rows || 1) - 1); } catch (e) {}
    try { if (typeof t.focus === 'function') t.focus(); } catch (e) {}
  }

  window.addEventListener('message', function (ev) {
    if (ev && ev.data && ev.data.type === 'dd-redraw') redraw();
  });

  // ── 3. Drag-to-select + auto-copy ──────────────────────────────────────
  // tmux mouse mode makes xterm.js forward all mouse events to the app
  // instead of handling selection natively. We intercept ALL left-button
  // events on the terminal and re-emit with shiftKey — xterm.js's standard
  // "bypass application mouse mode" signal. The initial mousedown MUST have
  // shiftKey or xterm.js never enters selection mode. Mouse wheel events
  // are untouched so tmux scrollback keeps working. Single left-clicks no
  // longer reach tmux (no click-to-position), which is fine for Claude Code.
  var SYN = '__dd';

  function shifted(e) {
    var n = new MouseEvent(e.type, {
      bubbles: true, cancelable: true, view: e.view, detail: e.detail,
      screenX: e.screenX, screenY: e.screenY,
      clientX: e.clientX, clientY: e.clientY,
      button: e.button, buttons: e.buttons,
      ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
      shiftKey: true, relatedTarget: e.relatedTarget
    });
    n[SYN] = 1;
    return n;
  }

  ['mousedown', 'mousemove', 'mouseup'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e[SYN] || e.shiftKey) return;
      if (!inTerm(e.target)) return;
      if (type === 'mousedown' && e.button !== 0) return;
      if (type === 'mouseup' && e.button !== 0) return;
      if (type === 'mousemove' && !(e.buttons & 1)) return;

      e.stopImmediatePropagation();
      e.preventDefault();
      e.target.dispatchEvent(shifted(e));
    }, true);
  });

  // Auto-copy: poll for terminal, then watch selection changes with a
  // debounce so we copy once after the drag settles, not on every pixel.
  (function waitForTerm() {
    var t = window.term;
    if (!t || !t.onSelectionChange) { setTimeout(waitForTerm, 300); return; }
    var timer;
    t.onSelectionChange(function () {
      clearTimeout(timer);
      if (!t.hasSelection()) return;
      timer = setTimeout(function () {
        var text = t.getSelection();
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () {});
        }
      }, 150);
    });
  })();

  // ── 4. Suppress browser context menu on terminal ────────────────────────
  document.addEventListener('contextmenu', function (e) {
    if (inTerm(e.target)) e.preventDefault();
  }, true);
})();

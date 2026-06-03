/*
 * domain-developer — in-terminal enhancements injected into ttyd's page.
 *
 * Injected at the very top of <head> (before ttyd's own bundle) so it can wrap
 * window.WebSocket before ttyd opens its socket. Provides two things:
 *
 *  1. Shift+Enter = newline. ttyd's xterm sends a bare CR ("\r") for BOTH
 *     Enter and Shift+Enter (its keymap ignores Shift for keyCode 13), so
 *     Claude Code's TUI can't tell them apart and submits on Shift+Enter.
 *     xterm emits ESC+CR ("\x1b\r") for Alt+Enter, which Claude treats as
 *     "insert newline". ttyd's input frame is [0x30 ('0'), ...utf8(payload)],
 *     so we put [0x30, 0x1b, 0x0d] on the socket for Shift+Enter.
 *
 *  2. Redraw / repaint. The panel's toolbar "Redraw" button posts
 *     {type:'dd-redraw'} into this iframe. We call window.term.clearTextureAtlas()
 *     + a full refresh. THIS is the real cure for the "dropped/garbled letters"
 *     bug: it's a corrupt glyph texture-atlas in xterm's renderer. A plain grid
 *     resize makes Claude repaint but xterm redraws from the SAME corrupt atlas,
 *     so the bad glyphs come right back — clearing the atlas forces every glyph
 *     to be re-rasterized. ttyd conveniently exposes the terminal as window.term.
 */
(function () {
  'use strict';

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

  // ttyd INPUT frame: '0' (0x30) + payload; payload = ESC (0x1b) + CR (0x0d).
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
})();

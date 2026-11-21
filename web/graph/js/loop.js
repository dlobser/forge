// loop.js — the one frame clock, kept running when the editor window can't paint.
//
// A browser only fires requestAnimationFrame for a window it is actually showing.
// Take a Viewer Window fullscreen on the same display and the editor behind it is
// covered, Chrome stops its rAF, and the whole graph — including the picture in
// the fullscreen window — freezes. So the loop has three drivers, in order:
//
//   1. this window's own rAF        the normal case; nothing else runs while it fires
//   2. each open Viewer Window's rAF that window IS on screen, so its vsync keeps
//                                   the graph going while the editor is covered
//   3. a worker heartbeat           last resort when nothing is visible at all (the
//                                   editor minimised, no viewer open); worker timers
//                                   aren't throttled the way a hidden page's are
//
// A helper only steps in once the window above it has gone quiet for STALL ms, so
// the graph never runs twice a frame.
import { RT } from './runtime.js';

const STALL = 60;

export function startLoop(frame) {
  let last = 0, lastMain = 0, lastPopup = 0;
  const run = () => { last = performance.now(); try { frame(); } catch (e) { console.error(e); } };

  const main = () => { lastMain = performance.now(); run(); requestAnimationFrame(main); };
  requestAnimationFrame(main);

  // 2. a popup's own rAF. The closure belongs to this window, so performance.now()
  //    is on the same clock as everything else.
  const popups = new Set();
  RT.addFrameWindow = (w) => {
    if (!w || popups.has(w)) return;
    popups.add(w);
    const tick = () => {
      if (w.closed) { popups.delete(w); return; }
      const now = performance.now();
      if (now - lastMain > STALL && now - last > 6) { lastPopup = now; run(); }
      try { w.requestAnimationFrame(tick); } catch (e) { popups.delete(w); }
    };
    try { w.requestAnimationFrame(tick); } catch (e) { popups.delete(w); }
  };

  // 3. heartbeat. Built from a blob so it needs no file of its own (and works in a
  //    static export); a page that forbids blob workers simply goes without.
  try {
    const src = 'setInterval(function(){postMessage(0)},16)';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = () => {
      const now = performance.now();
      if (now - lastMain > STALL && now - lastPopup > STALL && now - last > 14) run();
    };
  } catch (e) { /* no worker: the editor just pauses while hidden, as before */ }
}

// True while the editor window itself is being painted. Drawing the node canvas
// for a window nobody can see is wasted work when a helper is driving the loop.
export const editorVisible = () => !document.hidden;

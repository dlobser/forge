// help.js — the Help panel. Deliberately short: what the canvas gestures are, what
// the node categories mean, and the one thing that genuinely confuses people — that
// the whole editor runs in the browser with no server, and the Python server only
// exists for the two things a browser cannot do (talk to ComfyUI, run ffmpeg).
import { BTN, BTN_PRIMARY, h, modal, title } from './ui.js';

const SECTIONS = [
  {
    h: 'Getting around',
    rows: [
      ['Add a node', 'Double-click empty canvas, or the ＋ Add node button. Right-click the canvas for the full menu.'],
      ['Connect', 'Drag from an output dot to an input dot. Image pins are blue-grey; number pins carry values from Slider / math nodes.'],
      ['Pan / zoom', 'Drag empty canvas to pan, scroll to zoom.'],
      ['Delete', 'Select and press Delete. Ctrl+drag or shift-click to select several.'],
      ['Slider or pin?', 'Right-click a shader node ▸ Input Modes to turn any slider into an input pin, so a math or Audio Reactive node can drive it.'],
      ['Render size', 'Right-click a node ▸ Render size for that node alone; ⚙ Settings sets the default for new ones.'],
      ['Transport', 'The ▶ / ⏸ button freezes time, feedback loops, the webcam and the mic. Paused really is idle — edit at 2K without the graph grinding.'],
    ],
  },
  {
    h: 'Node categories',
    rows: [
      ['input', 'Where pictures and signals come from: Source (gallery), Import, URL Image, Webcam, Audio Reactive, Drawing (draw strokes in a pane; still or animated draw-on).'],
      ['image', 'Framing and tone: Crop / Scale, Blend, Key, Remap, Anti-alias.'],
      ['effect', 'Per-pixel looks: Blur, Distort, Edge Detect, Kaleidoscope, Mosaic…'],
      ['generate', 'Sources made from nothing: Noise, Gradient, SDF, Raymarch, Sine Wave.'],
      ['feedback', 'Nodes that remember the last frame: Video Feedback, Random Walk, Feedback Deform.'],
      ['cellular', 'Simulations on a grid: Kuramoto, Wilson-Cowan, Flood Fill.'],
      ['depth', 'Effects driven by a depth map.'],
      ['control / math', 'Sliders, toggles and arithmetic that drive other nodes’ pins.'],
      ['output', 'Viewer, Viewer Window, Save, Sequence → Video.'],
      ['local ai', 'Runs on your machine through ComfyUI (needs the Python server): your workflows, and Depth.'],
      ['cloud ai', 'Runs on ChatGPT or Gemini with your own API key: Depth, and Generate (a prompt → an image; connect a picture and it goes along with the prompt).'],
    ],
  },
  {
    h: 'Publishing what you made',
    rows: [
      ['Author UI', 'Right-click a widget ▸ ★ End-user UI ▸ Expose, or use the Author UI button. Tag a Viewer node as a preview window. That defines the page other people see.'],
      ['Authored view', 'File ▸ Open authored view — controls and viewer, no node graph. Works on a phone; several viewers become a dropdown, and ⬇ saves a PNG.'],
      ['Share link', 'File ▸ Share link… puts the entire graph in the URL. No account, nothing to install. Images imported into this browser can’t travel in a link — use URL Image nodes for those.'],
      ['Static site', 'export_static.py bakes a folder you can drop on any static host. Everything shader-based keeps working with no Python at all.'],
    ],
  },
  {
    h: 'What needs the Python server',
    rows: [
      ['Nothing visual', 'Every shader, the whole node graph, the authored UI and sharing are pure browser WebGL2. A static copy is fully interactive on its own.'],
      ['ComfyUI', 'Local AI nodes talk to ComfyUI on 127.0.0.1:8188. Only reachable from the machine running it.'],
      ['Cloud AI', 'Not these: ⚙ Settings ▸ Cloud AI picks ChatGPT or Gemini (Nano Banana) and takes your API key. They run from the browser, so they work on a published page too (visitors get a ✦ AI button for their own key).'],
      ['ffmpeg', 'Sequence → Video writes frames to disk and encodes them. Browsers can’t do either.'],
      ['To get those', 'Download the project, run start.bat (or python -m forge_server.server), open 127.0.0.1:8191, then load your graph or share link there.'],
    ],
  },
];

export function openHelp() {
  modal((card, close) => {
    title(card, 'Forge — quick help',
      'A node graph of WebGL2 image effects. Chain them, expose the knobs you want, '
      + 'and publish the result as a page or a link.');

    for (const sec of SECTIONS) {
      card.appendChild(h('div', 'color:#8a929c;text-transform:uppercase;font-size:10px;'
        + 'letter-spacing:1.5px;border-bottom:1px solid #262b33;padding-bottom:5px;'
        + 'margin:16px 0 8px', sec.h));
      for (const [k, v] of sec.rows) {
        const row = h('div', 'display:flex;gap:12px;padding:3px 0;align-items:baseline');
        row.appendChild(h('div', 'flex:0 0 108px;color:#cdd3da;font-size:12px', k));
        row.appendChild(h('div', 'flex:1;color:#9aa2ac;font-size:12px;line-height:1.5', v));
        card.appendChild(row);
      }
    }

    const row = h('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px');
    const docs = h('button', BTN, 'Keyboard shortcuts');
    docs.onclick = () => {
      card.replaceChildren();
      title(card, 'Keyboard shortcuts');
      const keys = [
        ['Ctrl+S', 'Save (records a version)'],
        ['Ctrl+Shift+S', 'Save As…'],
        ['Ctrl+O', 'Open graph…'],
        ['Ctrl+N', 'New graph'],
        ['Delete', 'Delete selected nodes'],
        ['Ctrl+C / Ctrl+V', 'Copy / paste nodes'],
        ['F', 'Fullscreen, while the live viewer is open'],
        ['Esc', 'Close the live viewer or any dialog'],
      ];
      for (const [k, v] of keys) {
        const r = h('div', 'display:flex;gap:12px;padding:4px 0');
        r.appendChild(h('div', 'flex:0 0 130px;color:#cdd3da;font:12px ui-monospace,monospace', k));
        r.appendChild(h('div', 'flex:1;color:#9aa2ac;font-size:12px', v));
        card.appendChild(r);
      }
      const back = h('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px');
      const b = h('button', BTN_PRIMARY, 'Close');
      b.onclick = close; back.appendChild(b); card.appendChild(back);
    };
    const ok = h('button', BTN_PRIMARY, 'Got it');
    ok.onclick = close;
    row.append(docs, ok);
    card.appendChild(row);
  });
}

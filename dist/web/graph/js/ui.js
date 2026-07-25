// ui.js — the small shared widget kit: toasts, modal cards, dropdown menus and
// the three dialogs (prompt / confirm / pick-from-list) the File menu needs.
//
// These were originally private to webeditor.js, which only ships in the static
// build. The File menu needs the same pieces in the desktop editor, so they live
// here and both import them rather than keeping two drifting copies.

export function h(tag, css, text) {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (text != null) el.textContent = text;
  return el;
}

export function toast(msg, kind) {
  const box = document.getElementById('toast');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 't' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const CARD = 'background:#15181d;border:1px solid #262b33;border-radius:12px;'
  + 'padding:22px 24px;max-width:520px;width:100%;line-height:1.6;color:#e6e8ea;'
  + 'font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 12px 40px #000a;'
  + 'max-height:88vh;overflow:auto;';

export const BTN = 'background:#1c2028;color:#e6e8ea;border:1px solid #262b33;'
  + 'border-radius:7px;padding:8px 16px;cursor:pointer;font-size:13px';
export const BTN_PRIMARY = 'background:#5b8cff;color:#fff;border:none;border-radius:7px;'
  + 'padding:8px 16px;cursor:pointer;font-size:13px';
export const BTN_DANGER = 'background:#3a1d21;color:#ff8f9a;border:1px solid #5c2a32;'
  + 'border-radius:7px;padding:8px 16px;cursor:pointer;font-size:13px';
export const FIELD = 'width:100%;background:#0d0f12;color:#e6e8ea;border:1px solid #262b33;'
  + 'border-radius:6px;padding:9px 10px;font-size:13px;margin-bottom:12px';

// A modal card. `build(card, close)` fills it in. Escape and backdrop both close.
// `onClose` fires however the card goes away — the dialogs below rely on that to
// settle their promise when the user dismisses instead of choosing, which would
// otherwise leave the caller awaiting forever.
export function modal(build, onClose) {
  const back = h('div', 'position:fixed;inset:0;z-index:200;background:#000c;display:flex;'
    + 'align-items:center;justify-content:center;padding:20px;');
  const card = h('div', CARD);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.onclick = (e) => { if (e.target === back) close(); };
  build(card, close);
  back.appendChild(card);
  document.body.appendChild(back);
  return close;
}

export function title(card, text, sub) {
  card.appendChild(h('div', 'font-size:17px;margin-bottom:' + (sub ? '4px' : '14px'), text));
  if (sub) card.appendChild(h('div', 'color:#8a929c;margin-bottom:14px', sub));
}

function buttonRow(card, buttons) {
  const row = h('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px');
  for (const b of buttons) row.appendChild(b);
  card.appendChild(row);
  return row;
}

// Text prompt. Resolves to the entered string, or null if cancelled/dismissed.
export function askText(opts) {
  return new Promise((resolve) => {
    let value = null;
    modal((card, close) => {
      title(card, opts.title, opts.sub);
      const input = h('input', FIELD);
      input.value = opts.value || '';
      card.appendChild(input);
      const cancel = h('button', BTN, 'Cancel');
      const ok = h('button', BTN_PRIMARY, opts.ok || 'OK');
      buttonRow(card, [cancel, ok]);
      const submit = () => {
        const v = input.value.trim();
        if (!v) return input.focus();
        value = v; close();
      };
      ok.onclick = submit;
      cancel.onclick = close;
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }, () => resolve(value));
  });
}

// Yes/no. Resolves true only on the confirm button.
export function askConfirm(opts) {
  return new Promise((resolve) => {
    let value = false;
    modal((card, close) => {
      title(card, opts.title, opts.sub);
      const cancel = h('button', BTN, opts.cancel || 'Cancel');
      const ok = h('button', opts.danger ? BTN_DANGER : BTN_PRIMARY, opts.ok || 'OK');
      buttonRow(card, [cancel, ok]);
      ok.onclick = () => { value = true; close(); };
      cancel.onclick = close;
      setTimeout(() => ok.focus(), 0);
    }, () => resolve(value));
  });
}

// A stack of labelled choices, each with a line explaining what it does. Used
// where a plain OK/Cancel would hide the consequences — switching projects, say.
// `choices` are {key, label, hint, primary}. Resolves the chosen key, or null.
export function askChoice(opts) {
  return new Promise((resolve) => {
    let value = null;
    modal((card, close) => {
      title(card, opts.title, opts.sub);
      for (const w of opts.warnings || []) {
        card.appendChild(h('div', 'background:#2a1d1d;border:1px solid #5c2a2a;color:#ffb0b0;'
          + 'border-radius:8px;padding:9px 11px;margin-bottom:10px;font-size:12px', '⚠ ' + w));
      }
      const stack = h('div', 'display:flex;flex-direction:column;gap:8px;margin-bottom:14px');
      for (const c of opts.choices) {
        const b = h('button', 'text-align:left;border-radius:8px;padding:10px 12px;cursor:pointer;'
          + 'font-size:13px;line-height:1.45;'
          + (c.primary
            ? 'background:#1e2a44;border:1px solid #3a5a8a;color:#e6e8ea;'
            : 'background:#12161c;border:1px solid #262b33;color:#e6e8ea;'));
        b.appendChild(h('div', 'font-weight:600', c.label));
        if (c.hint) b.appendChild(h('div', 'color:#8a929c;font-size:11.5px', c.hint));
        b.onclick = () => { value = c.key; close(); };
        stack.appendChild(b);
      }
      card.appendChild(stack);
      const cancel = h('button', BTN, 'Cancel');
      cancel.onclick = close;
      const row = h('div', 'display:flex;justify-content:flex-end');
      row.appendChild(cancel);
      card.appendChild(row);
    }, () => resolve(value));
  });
}

// A scrollable list of choices. `rows` are {id, label, meta, actions:[{label,css,fn}]}.
// Resolves with the chosen id, or null.
export function askList(opts) {
  return new Promise((resolve) => {
    let value = null;
    const finish = (v) => { value = v; };
    modal((card, close) => {
      title(card, opts.title, opts.sub);
      const list = h('div', 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px;'
        + 'max-height:46vh;overflow:auto');
      if (!opts.rows.length) {
        list.appendChild(h('div', 'color:#8a929c;padding:8px 2px', opts.empty || 'Nothing here yet.'));
      }
      for (const r of opts.rows) {
        const row = h('div', 'display:flex;align-items:center;gap:10px;background:#12161c;'
          + 'border:1px solid ' + (r.current ? '#2f4a7a' : '#262b33') + ';border-radius:8px;'
          + 'padding:9px 11px;cursor:pointer');
        const textCol = h('div', 'flex:1;min-width:0');
        textCol.appendChild(h('div', 'color:#e6e8ea;white-space:nowrap;overflow:hidden;'
          + 'text-overflow:ellipsis', r.label + (r.current ? '  ·  open' : '')));
        if (r.meta) textCol.appendChild(h('div', 'color:#8a929c;font-size:11px', r.meta));
        row.appendChild(textCol);
        row.onclick = () => { finish(r.id); close(); };
        for (const a of r.actions || []) {
          const b = h('button', (a.css || BTN) + ';padding:5px 10px;font-size:12px', a.label);
          b.onclick = (e) => { e.stopPropagation(); a.fn(r, close, finish); };
          row.appendChild(b);
        }
        list.appendChild(row);
      }
      card.appendChild(list);
      const cancel = h('button', BTN, 'Close');
      cancel.onclick = close;
      const extra = (opts.buttons || []).map((b) => {
        const el = h('button', b.primary ? BTN_PRIMARY : BTN, b.label);
        el.onclick = () => b.fn(close, finish);
        return el;
      });
      buttonRow(card, [cancel, ...extra]);
    }, () => resolve(value));
  });
}

// ── dropdown menu ────────────────────────────────────────────────────────────
// items: {label, hint, fn, disabled} or the string '-' for a separator.
export function dropdown(anchor, items) {
  const open = document.getElementById('__forgeMenu');
  if (open) { open.remove(); if (open.dataset.for === anchor.id) return; }

  const menu = h('div', 'position:fixed;z-index:300;background:#15181d;border:1px solid #2d333c;'
    + 'border-radius:9px;padding:5px;min-width:250px;box-shadow:0 14px 40px #000b;'
    + 'font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;');
  menu.id = '__forgeMenu';
  menu.dataset.for = anchor.id || '';

  for (const it of items) {
    if (it === '-') {
      menu.appendChild(h('div', 'height:1px;background:#262b33;margin:5px 4px'));
      continue;
    }
    const row = h('div', 'display:flex;align-items:center;gap:14px;padding:7px 10px;'
      + 'border-radius:6px;white-space:nowrap;'
      + (it.disabled ? 'color:#5b636e;cursor:default;' : 'color:#e6e8ea;cursor:pointer;'));
    row.appendChild(h('span', 'flex:1', it.label));
    if (it.hint) row.appendChild(h('span', 'color:#6d7681;font-size:11px', it.hint));
    if (!it.disabled) {
      row.onmouseenter = () => { row.style.background = '#232833'; };
      row.onmouseleave = () => { row.style.background = 'transparent'; };
      row.onclick = () => { close(); it.fn(); };
    }
    menu.appendChild(row);
  }

  function close() {
    menu.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onDoc(e) { if (!menu.contains(e.target) && e.target !== anchor) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

// ── file download / upload helpers ───────────────────────────────────────────
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const a = h('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function pickJSONFile() {
  return new Promise((resolve) => {
    const inp = h('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return resolve(null);
      try { resolve(JSON.parse(await f.text())); }
      catch (e) { resolve({ __error: 'That file is not valid JSON.' }); }
    };
    inp.click();
  });
}

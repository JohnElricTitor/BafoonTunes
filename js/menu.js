// Small right-click menu used by the sound list and the on-screen pads.
// items: [{ label, run, danger?, checked? }, '-' (separator), …]

let menuEl = null;

export function showMenu(x, y, items) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  menuEl.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
    if (it.heading) {
      const h = document.createElement('div');
      h.className = 'ctx-heading';
      h.textContent = it.heading;
      menuEl.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '');
    b.textContent = it.label;
    b.setAttribute('role', it.checked !== undefined ? 'menuitemradio' : 'menuitem');
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
    b.onclick = () => { closeMenu(); it.run(); };
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  menuEl.querySelector('.ctx-item')?.focus();
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escClose, true);
    document.addEventListener('scroll', closeMenu, true);
    window.addEventListener('blur', closeMenu);
  });
}

function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
function escClose(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
}

export function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', escClose, true);
  document.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('blur', closeMenu);
}

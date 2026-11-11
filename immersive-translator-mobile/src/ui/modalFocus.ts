/** Focus and background ownership shared by reading drawers and global sheets.
 * Locks are counted so closing a lower drawer cannot unlock a sheet above it. */
const locks = new Map<HTMLElement, number>();
const controls = 'button,input,select,textarea,a[href],summary,[contenteditable],[tabindex]';

function visible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    if (node.classList.contains('sheet') && !node.classList.contains('on')) return false;
    if (node.classList.contains('push') && !node.classList.contains('in')) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function level(element: HTMLElement): number {
  const value = Number.parseInt(getComputedStyle(element).zIndex || element.style.zIndex, 10);
  if (Number.isFinite(value)) return value;
  // These defaults also keep component tests faithful without loading app CSS.
  if (element.classList.contains('sheet')) return 45;
  if (element.classList.contains('push')) return 40;
  return 0;
}

function topModal(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    .filter(element => visible(element) && !element.closest('[inert]'))
    .sort((a, b) => level(a) - level(b) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .at(-1);
}

function focusable(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(controls)].filter(element =>
    !element.matches(':disabled,input[type="hidden"]') && !element.closest('[inert]') && visible(element) &&
    (element.tabIndex >= 0 || element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false' && !element.hasAttribute('tabindex')),
  );
}

function lock(element: HTMLElement): (() => void) | null {
  const count = locks.get(element);
  // An existing framework-owned inert state must survive the modal's cleanup.
  if (count === undefined && element.hasAttribute('inert')) return null;
  locks.set(element, (count || 0) + 1);
  element.setAttribute('inert', '');
  return () => {
    const remaining = (locks.get(element) || 1) - 1;
    if (remaining) {
      locks.set(element, remaining);
      // React may have removed its own inert prop during the same close commit.
      // The remaining lower modal still owns this background lock.
      element.setAttribute('inert', '');
      return;
    }
    locks.delete(element);
    // Closing a covered sheet may have set inert while our lock was held.
    if (element.classList.contains('sheet') && !element.classList.contains('on')) return;
    element.removeAttribute('inert');
  };
}

export function attachModalFocus(panel: HTMLElement, onClose: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ancestors: HTMLElement[] = [];
  for (let node = previous?.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node);
  const releases: (() => void)[] = [];
  const backdrop = panel.previousElementSibling?.classList.contains('sheet-dim') ? panel.previousElementSibling : null;
  let branch: HTMLElement = panel;
  for (let parent = branch.parentElement; parent; parent = branch.parentElement) {
    for (const sibling of parent.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch || sibling === backdrop || sibling.contains(backdrop)) continue;
      // Backdrops are decorative and layered by z-index. A lower drawer must
      // never retain an inert lock on a higher sheet's permanently mounted dim.
      if (sibling.matches('script,style,link,meta,.sheet-dim,.push-scrim')) continue;
      const higher = [...sibling.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'), ...(sibling.matches('[role="dialog"][aria-modal="true"]') ? [sibling] : [])]
        .some(element => visible(element) && !element.closest('[inert]') && level(element) > level(panel));
      if (higher) continue;
      const release = lock(sibling); if (release) releases.push(release);
    }
    if (parent === document.body) break;
    branch = parent;
  }
  let lastFocus: HTMLElement | null = null;
  const focusInside = () => {
    const items = focusable(panel);
    const target = lastFocus && items.includes(lastFocus) ? lastFocus : items[0] || panel;
    target.focus({ preventScroll: true });
  };
  const active = () => topModal() === panel;
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !active()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = focusable(panel), first = items[0] || panel, last = items.at(-1) || panel;
    if (!panel.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || !items.length) {
      event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  };
  const focus = () => {
    if (!active()) return;
    if (panel.contains(document.activeElement)) lastFocus = document.activeElement as HTMLElement;
    else focusInside();
  };
  document.addEventListener('keydown', key);
  document.addEventListener('focusin', focus);
  if (active()) focusInside();
  return () => {
    document.removeEventListener('keydown', key);
    document.removeEventListener('focusin', focus);
    releases.reverse().forEach(release => release());
    const top = topModal();
    if (previous?.isConnected && !previous.closest('[inert]') && visible(previous) && (!top || top.contains(previous))) {
      previous.focus({ preventScroll: true });
    } else if (!document.activeElement || document.activeElement === document.body || panel.contains(document.activeElement)) {
      // The trigger can disappear when a covered lower drawer closes first.
      // Return to the next available control in its surviving context.
      const context = top || ancestors.find(element => element.isConnected && !element.closest('[inert]') && visible(element));
      const target = context && focusable(context)[0];
      target?.focus({ preventScroll: true });
    }
  };
}

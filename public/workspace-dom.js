// Patch connected nodes in place. Never detach an unchanged iframe (including
// its ancestors): WebKit reloads its browsing context when it is reinserted.
const renderedValues = new WeakMap();
const listeners = new WeakMap();

function key(node) {
  if (node.nodeType !== 1) return '';
  for (const attribute of ['id', 'data-panel', 'data-message-id', 'data-file', 'data-folder']) {
    if (node.hasAttribute(attribute)) return `${attribute}:${node.getAttribute(attribute)}`;
  }
  return '';
}

function matches(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
}

function patchNode(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  // Inputs without state-backed values (e.g. a URL being typed) retain their
  // live value until the rendered value actually changes.
  const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName);
  const oldValue = field ? (renderedValues.has(current) ? renderedValues.get(current) : current.tagName === 'TEXTAREA' ? current.textContent : current.tagName === 'INPUT' ? current.getAttribute('value') || '' : current.value) : null;
  const nextValue = field ? next.value : null;
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  if (current.tagName !== 'TEXTAREA') patchChildren(current, next);
  if (field) {
    if (oldValue !== nextValue && current.value !== nextValue) current.value = nextValue;
    renderedValues.set(current, nextValue);
  }
}

function patchChildren(parent, next) {
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    let current = cursor;
    if (!current || !matches(current, desired)) {
      // Keyed siblings can be inserted/removed without replacing other panels.
      current = key(desired) ? [...parent.childNodes].find(node => matches(node, desired)) : null;
      if (current) {
        // Remove obsolete preceding siblings, rather than moving a surviving
        // input/iframe out of place just to close a menu or attachment banner.
        while (cursor !== current && ![...next.childNodes].some(node => matches(cursor, node))) {
          const obsolete = cursor;
          cursor = cursor.nextSibling;
          obsolete.remove();
        }
        if (current !== cursor) parent.insertBefore(current, cursor);
      }
      else {
        current = desired.cloneNode(true);
        parent.insertBefore(current, cursor);
      }
    }
    patchNode(current, desired);
    cursor = current.nextSibling;
  }
  while (cursor) {
    const following = cursor.nextSibling;
    cursor.remove();
    cursor = following;
  }
}

export function renderWorkspace(root, html, { reloadPreview = false } = {}) {
  const template = root.ownerDocument.createElement('template');
  template.innerHTML = html;
  const frame = root.querySelector('.preview-frame');
  const previousSource = frame?.getAttribute('src');
  patchChildren(root, template.content);
  // A changed URL already navigated during patching. Explicitly reload only
  // when the user submits the same URL; ordinary renders never touch src.
  if (reloadPreview && frame?.isConnected && frame.getAttribute('src') === previousSource) {
    frame.setAttribute('src', previousSource);
  }
}

// bind() runs after rendering; replace each owned handler rather than stacking
// callbacks on the persistent editor, composer, and preview controls.
export function listen(element, type, handler) {
  if (!element) return;
  let owned = listeners.get(element);
  if (!owned) listeners.set(element, owned = new Map());
  const previous = owned.get(type);
  if (previous) element.removeEventListener(type, previous);
  owned.set(type, handler);
  element.addEventListener(type, handler);
}

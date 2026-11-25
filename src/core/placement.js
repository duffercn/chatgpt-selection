// Prefer the quiet right-hand gutter rather than the conversation composer.
export function choosePlacement(viewport, size, obstacles) {
  const inset = 16;
  const gap = 8;
  const x = viewport.width - size.width - inset;
  if (x < inset || viewport.height < size.height + 2 * inset) return null;
  const center = (viewport.height - size.height) / 2;
  const candidates = [center];
  for (let offset = 56; offset < viewport.height; offset += 56) {
    candidates.push(center - offset, center + offset);
  }
  for (const top of candidates) {
    if (top < inset || top + size.height > viewport.height - inset) continue;
    if (obstacles.every(r =>
      x + size.width + gap <= r.left || x - gap >= r.right ||
      top + size.height + gap <= r.top || top - gap >= r.bottom
    )) return { top, right: inset };
  }
  return null;
}

export function positionButton(button) {
  const selector = 'button, a[href], input, textarea, select, form, [contenteditable="true"], [role="button"], [role="textbox"], [role="menu"], [role="dialog"], [role="toolbar"], p, pre, table, li, h1, h2, h3, h4, blockquote';
  const obstacles = [...document.querySelectorAll(selector)]
    .filter(element => element !== button && !button.contains(element))
    .map(element => element.getBoundingClientRect())
    .filter(r => r.width > 0 && r.height > 0);
  const placement = choosePlacement(
    { width: innerWidth, height: innerHeight },
    { width: button.offsetWidth, height: button.offsetHeight },
    obstacles
  );
  button.style.visibility = placement ? "visible" : "hidden";
  if (placement) {
    button.style.top = placement.top + "px";
    button.style.right = placement.right + "px";
  }
}

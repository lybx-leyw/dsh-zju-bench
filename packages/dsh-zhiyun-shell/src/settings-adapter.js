/** Version-specific DSH 0.2 bridge: preserve the original slot entry's child
 * authorization and store, and restore its component when this bundle unloads. */
export function adaptSettingsSurface(slots, wrap) {
  let entry;
  let original;
  let adapted;
  const restore = () => {
    if (entry && entry.component === adapted) entry.component = original;
  };
  const bind = () => {
    const next = slots.entries('sidebar.settings')[0];
    if (next === entry) return;
    restore();
    entry = next;
    if (!entry) return;
    original = entry.component;
    adapted = wrap(original);
    entry.component = adapted;
  };
  bind();
  const off = slots.subscribe('sidebar.settings', bind);
  return () => { off(); restore(); };
}

// Visual-only (Session 18.2). The actual <input type="checkbox"> stays in
// the DOM as a real, submittable form control — only visually hidden
// (Tailwind's sr-only, not display:none/opacity:0+zero-size, so it stays in
// the accessibility tree and the tab order). The reference file
// (docs/reference/publications-redesign-pegasus-ledger.html) has no focus
// state for the hidden-checkbox pattern — peer-focus-visible: below is the
// fix: a visible ring on the label when the underlying input has keyboard
// focus, so tabbing through filters works without a mouse.
export function FilterChip({
  name,
  value,
  label,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  defaultChecked: boolean;
}) {
  const id = `chip-${name}-${value}`;
  return (
    <>
      <input type="checkbox" id={id} name={name} value={value} defaultChecked={defaultChecked} className="peer sr-only" />
      <label
        htmlFor={id}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] border border-[#D8D8D8] text-[#5B5B5B] cursor-pointer select-none transition-colors hover:border-[#B8B8B8] peer-checked:bg-[#0A0A0A] peer-checked:border-[#0A0A0A] peer-checked:text-ucf-gold peer-checked:font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-ucf-gold peer-focus-visible:ring-offset-2 peer-focus-visible:outline-none"
      >
        {label}
      </label>
    </>
  );
}

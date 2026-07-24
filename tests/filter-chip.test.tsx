// Session 18.3: a chip's rendered "active" style must never leak onto a
// sibling chip. Tailwind's peer-checked: compiles to a general-sibling CSS
// selector (~), which matches ANY later sibling carrying the "peer" class —
// not just the one immediately paired with it. Multiple <FilterChip>s
// rendered as bare React Fragments inside the same flex row become flat DOM
// siblings of EACH OTHER, so an earlier checked chip's peer-checked: styles
// cascade onto every later chip in that row, regardless of that chip's own
// checked state. This renders the exact harness shape page.tsx uses (several
// chips inside one flex container) and inspects the real HTML structure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterChip } from "../app/admin/publications/FilterChip";

function renderRow() {
  return renderToStaticMarkup(
    <div className="flex flex-wrap gap-2">
      <FilterChip name="status" value="published" label="Published" defaultChecked={true} />
      <FilterChip name="status" value="pending_merge" label="Pending merge" defaultChecked={false} />
      <FilterChip name="status" value="needs_metadata" label="Needs metadata" defaultChecked={false} />
    </div>
  );
}

describe("FilterChip — sibling isolation", () => {
  it("each chip's input+label pair is wrapped in its own container, not left as flat siblings of other chips' inputs/labels", () => {
    const html = renderRow();

    // The buggy shape emits input/label pairs as direct, unwrapped flat
    // siblings: ...</label><input... (a later chip's <input> immediately
    // follows an earlier chip's </label> with no intervening container
    // boundary) — meaning every label after the first checked input sits in
    // the same peer-sibling scope as that input. The fix must close each
    // chip's own wrapper before the next chip's input appears.
    expect(html).not.toMatch(/<\/label><input/);
  });
});

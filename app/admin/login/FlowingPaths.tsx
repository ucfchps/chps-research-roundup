"use client";

import { useMemo } from "react";

const COUNT = 22;

// Same curve formula/character as docs/reference/login-redesign-floating-paths.html's
// imperative <script> — reimplemented as data computed once (useMemo), not
// DOM built by hand. motion-reduce:animate-none is the fix for a real gap in
// that reference: it never accounted for prefers-reduced-motion at all.
export function FlowingPaths() {
  const paths = useMemo(
    () =>
      Array.from({ length: COUNT }, (_, i) => {
        const yStart = -80 + i * 34;
        const yMid = 220 + i * 14;
        const yEnd = 720 - i * 6;
        const xShift = i * 6;

        const d =
          `M${-120 - xShift},${yStart} ` +
          `C${140 - xShift},${yStart - 40} ${260 + xShift},${yMid - 120} ${420 + xShift},${yMid} ` +
          `S${760 + xShift},${yEnd - 80} ${920 + xShift},${yEnd}`;

        return {
          d,
          opacity: 0.08 + (i / COUNT) * 0.3,
          strokeWidth: 0.5 + i * 0.03,
          delay: -i * 0.7,
        };
      }),
    []
  );

  return (
    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke="#FFC904"
          strokeWidth={p.strokeWidth}
          strokeDasharray="260 900"
          className="animate-flow-path motion-reduce:animate-none"
          style={{ opacity: p.opacity, animationDelay: `${p.delay}s` }}
        />
      ))}
    </svg>
  );
}

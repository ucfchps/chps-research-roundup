// Visual-only (Session 18.2). A static, non-animated echo of the login
// page's flowing-paths motif (docs/reference/login-redesign-floating-paths.html)
// — this page is for repeated, focused scanning, not a landing moment, so no
// animation here. The other nav items are real future admin sections
// (build-order items 16–20) that don't exist yet — rendered as plain,
// non-interactive elements rather than dead links, so they don't create
// broken tab stops or 404s for a keyboard user probing the sidebar.
import type { ReactNode } from "react";

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      {children}
    </svg>
  );
}

const FUTURE_NAV_ITEMS: Array<{ label: string; icon: ReactNode }> = [
  {
    label: "Pending submissions",
    icon: (
      <>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </>
    ),
  },
  {
    label: "Needs metadata",
    icon: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </>
    ),
  },
  {
    label: "Review campaigns",
    icon: (
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </>
    ),
  },
  {
    label: "Archive",
    icon: (
      <>
        <rect x="2" y="3" width="20" height="5" rx="1" />
        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
      </>
    ),
  },
];

export function Sidebar() {
  return (
    <aside className="w-60 bg-[#0A0A0A] px-5 py-6 shrink-0 relative overflow-hidden">
      <svg className="absolute inset-0 w-full h-full opacity-[0.05]" viewBox="0 0 240 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path d="M-40,60 C120,20 160,180 260,220 S420,420 480,460" stroke="#FFC904" strokeWidth="1" fill="none" />
        <path d="M-60,280 C100,240 150,400 250,440 S400,640 470,680" stroke="#FFC904" strokeWidth="1" fill="none" />
        <path d="M-30,520 C130,480 170,620 270,660 S430,760 490,790" stroke="#FFC904" strokeWidth="1" fill="none" />
      </svg>

      <div className="relative z-10 flex items-center gap-2.5 mb-9">
        <div className="w-7 h-7 rounded-full border border-ucf-gold/50 flex items-center justify-center shrink-0">
          <div className="w-1.5 h-1.5 rounded-full bg-ucf-gold" />
        </div>
        <span className="text-white text-sm tracking-wide">CHPS Roundup</span>
      </div>

      <nav className="relative z-10 space-y-0.5 text-sm">
        <a href="/admin/publications" className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-white/10 text-white">
          <NavIcon>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </NavIcon>
          Publications
        </a>
        {FUTURE_NAV_ITEMS.map((item) => (
          <div key={item.label} className="flex items-center gap-2.5 px-3 py-2 rounded-md text-[#6B6B6B]" aria-disabled="true">
            <NavIcon>{item.icon}</NavIcon>
            {item.label}
          </div>
        ))}
      </nav>

      <div className="relative z-10 mt-10 pt-4 border-t border-white/10 text-xs text-[#7A7A7A]">Signed in as COMMS</div>
    </aside>
  );
}

"use client";

import { useActionState } from "react";
import { loginAction, type LoginFormState } from "./actions";
import { FlowingPaths } from "./FlowingPaths";
import { archivo, inter } from "../fonts";

const initialState: LoginFormState = { error: null };

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <div className={`flex min-h-screen flex-col md:flex-row ${inter.variable} ${archivo.variable}`} style={{ fontFamily: "var(--font-inter)" }}>
      {/* LEFT: flowing paths panel */}
      <div className="relative w-full md:w-3/5 min-h-[280px] md:min-h-screen bg-black overflow-hidden">
        <FlowingPaths />
        <div
          className="absolute inset-0"
          style={{ background: "radial-gradient(circle at 25% 30%, rgba(255,201,4,0.05), transparent 55%)" }}
        />

        <div className="relative z-10 h-full flex flex-col justify-between p-10 md:p-14">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full border border-ucf-gold/60 flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-ucf-gold" />
            </div>
            <span className="text-white text-sm tracking-wide">CHPS Research Roundup</span>
          </div>

          <div className="max-w-sm">
            <p className="text-white text-3xl md:text-4xl font-semibold leading-tight mb-4" style={{ fontFamily: "var(--font-archivo)" }}>
              Every publication,
              <br />
              traced back to its people.
            </p>
            <p className="text-[#B8B8B8] text-sm leading-relaxed">
              College of Health Professions and Sciences — internal tool for tracking, verifying, and publishing faculty
              research.
            </p>
          </div>

          <p className="text-[#6B6B6B] text-xs">University of Central Florida</p>
        </div>
      </div>

      {/* RIGHT: minimal password-only login — same loginAction/useActionState as before, restyled */}
      <div className="w-full md:w-2/5 flex items-center justify-center bg-white px-8 py-16">
        <div className="w-full max-w-[320px]">
          <p className="text-xl font-semibold mb-1 text-black" style={{ fontFamily: "var(--font-archivo)" }}>
            Admin sign in
          </p>
          <p className="text-sm text-[#6B6B6B] mb-8">Enter the shared password to continue.</p>

          <form action={formAction}>
            <label htmlFor="password" className="block text-xs uppercase tracking-wide text-[#6B6B6B] mb-2">
              Password
            </label>
            <input
              type="password"
              id="password"
              name="password"
              placeholder="••••••••••••"
              required
              autoFocus
              className="w-full border border-[#D9D9D9] rounded-md px-3 py-2.5 mb-4 text-sm focus:outline-none focus:border-ucf-gold focus:ring-2 focus:ring-ucf-gold/30 transition-shadow"
            />

            <button
              type="submit"
              disabled={pending}
              className="w-full bg-black text-white text-sm font-medium py-2.5 rounded-md hover:bg-[#1A1A1A] transition-colors disabled:opacity-50"
            >
              {pending ? "Signing in…" : "Sign in"}
            </button>

            {state.error && <p className="text-sm text-red-600 mt-3">{state.error}</p>}
          </form>

          <p className="text-xs text-[#9A9A9A] mt-6">This tool is limited to CHPS communications staff.</p>
        </div>
      </div>
    </div>
  );
}

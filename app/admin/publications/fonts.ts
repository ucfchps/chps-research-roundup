// Visual-only (Session 18.2). Matches the reference design's font choices
// (docs/reference/publications-redesign-pegasus-ledger.html and the login
// redesign reference, which use the same three). Scoped to this page via
// CSS variables rather than changed at the root layout — out of scope to
// touch every other page's typography in a session about restyling one page.
import { Archivo, Inter, JetBrains_Mono } from "next/font/google";

export const archivo = Archivo({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-archivo" });
export const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
export const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains-mono" });

// Shared across the admin surface (publications, login, and whatever admin
// screens follow) — one font-loader module, not each page instantiating its
// own next/font/google call for the same three fonts. Matches the reference
// designs' font choices (docs/reference/*-redesign-*.html). Applied via CSS
// variables scoped to each page's own subtree, not the root layout — out of
// scope for a restyle session to change every other page's typography.
import { Archivo, Inter, JetBrains_Mono } from "next/font/google";

export const archivo = Archivo({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-archivo" });
export const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
export const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains-mono" });

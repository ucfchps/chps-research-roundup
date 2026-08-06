// Vitest setupFiles entry (see vitest.config.ts) — runs before every test
// file. Installs the Phase 5 network guard globally; see
// tests/helpers/http.ts for what it does and why it sits on global fetch
// rather than lib/http.ts's wrapper.
import { installNetworkGuard } from "./helpers/http";

installNetworkGuard();

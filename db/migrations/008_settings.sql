-- Generic key-value settings table (§8c, once /admin exists this grows into a
-- proper settings tab). Session 16.2's only current consumer is the outbound
-- email kill switch — a key-value shape, not a single-purpose column, so
-- future toggles don't each need their own migration.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

-- Defaults to disabled — see lib/settings.ts::isEmailNotificationsEnabled for
-- why "no row at all" must also be treated as disabled, not just this value.
INSERT INTO settings (key, value, updated_at, updated_by)
VALUES ('email_notifications_enabled', 'false', datetime('now'), 'migration');

-- Rollback 268: remove the notes.polish_report permission grants.
-- NOTE: this drops the key from EVERY role (incl. any an admin later granted it
-- to), since the key ceases to exist. Safe to run before reverting the code that
-- reads `notes.polish_report`.
DELETE FROM company_role_permissions
WHERE permission_key = 'notes.polish_report';

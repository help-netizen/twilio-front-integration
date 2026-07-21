-- 194 is an irreversible data cleanup. Re-introducing duplicate elements or
-- removing restored created timestamps would corrupt repaired note history.
-- The forward migration is idempotent and safe to retain during rollback.
SELECT 1;

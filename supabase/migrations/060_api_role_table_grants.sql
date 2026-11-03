-- A fresh Postgres (local `npm run db:start`, and the same stack on a
-- server) creates migration tables without SELECT/INSERT/UPDATE/DELETE
-- for anon, authenticated, and service_role. Hosted projects created
-- before that default change already have those grants, which is why
-- the app can read broadcasts there. RLS still decides which rows
-- each role can see.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO anon, authenticated, service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES
  TO anon, authenticated, service_role;

-- 054 keeps this scratch table off the public API. The grant above
-- would put it back.
REVOKE ALL ON TABLE public.pending_message_statuses FROM anon, authenticated;

-- These trigger functions were revoked from the API roles so they
-- cannot be called as RPCs. The role that writes the row still needs
-- EXECUTE or the trigger fails. PostgREST does not expose functions
-- that return trigger.
GRANT EXECUTE ON FUNCTION public.track_conversation_message_times()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_conversation_assignee_membership()
  TO authenticated, service_role;

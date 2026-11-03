import { createAdminClient, type PostgresClient } from '@/lib/db/server'

let _adminClient: PostgresClient | null = null

export function supabaseAdmin(): PostgresClient {
  if (!_adminClient) _adminClient = createAdminClient()
  return _adminClient
}

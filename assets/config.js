/* Orbit — optional sync configuration.
 *
 * Leave these empty and Orbit stays exactly what it was: a local-only chart with
 * no accounts and no network. Fill them in (or paste them into Settings → Account
 * on the device itself) and the same document syncs across your devices.
 *
 * Both values are meant to be public. The anon key is a client key; every row is
 * fenced off by row-level security in Postgres, so it can only ever read or write
 * the signed-in account's own row. See README → "Sync" for the SQL and the setup.
 */
window.ORBIT_CONFIG = {
  supabaseUrl: '',       // e.g. 'https://abcdefghijklm.supabase.co'
  supabaseAnonKey: ''    // the project's public anon key
};

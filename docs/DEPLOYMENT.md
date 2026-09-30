# Deploying to Vercel with Supabase

This repository contains a Vite/React frontend and an Express API. Supabase provides authentication and the database. The Vercel build settings, API function, and rewrites are configured in the repository.

## 1. Set up the Supabase project

Create or select a project in the [Supabase Dashboard](https://supabase.com/dashboard). From **Project Settings → API**, collect:

- The project URL
- The public `anon` key
- The secret `service_role` key

The browser client currently gets its Supabase project ID and public anon key from `client/src/utils/supabase/info.tsx`. If using a new Supabase project, replace those values in that file with the new project's project ID and anon key. The anon key is intended to be public; never put the service-role key in frontend code.

### Create the app's database table

The server stores app records in a JSON key/value table named `kv_store_2fad19e1`. It uses Supabase Auth for user accounts, so there are no separate teacher/student SQL tables to create.

In Supabase, open **SQL Editor → New query** and run:

```sql
create table if not exists public.kv_store_2fad19e1 (
  key text primary key,
  value jsonb not null
);

alter table public.kv_store_2fad19e1 enable row level security;

revoke all on table public.kv_store_2fad19e1 from anon, authenticated;
grant all on table public.kv_store_2fad19e1 to service_role;
```

No RLS policy is needed: the Express API accesses this table with the `service_role` key, which bypasses RLS. Do not grant `anon` or `authenticated` access to this table; the browser should use the API rather than reading this private app data directly.

In **Authentication → URL Configuration**, set the Site URL to the production Vercel domain. Add production and preview redirect URLs to the allowlist if using email redirects.

## 2. Wire the Express API for Vercel

The root `vercel.json` defines two Vercel services: `client` (Vite, rooted at `client`) and `server` (Express, rooted at `server`). Requests under `/make-server-2fad19e1/...` and `/health` route to the Express service; all remaining paths route to the Vite client for the app and its SPA routes. The service names and public paths must match the package layout and route prefixes used by the code.

The browser calls the backend through same-domain URLs under `/make-server-2fad19e1/...`; top-level rewrites route those requests to the server service. No service binding is required because neither service makes a server-side request to the other. The Vite dev server's `localhost:3001` proxy is only for local development.

## 3. Deploy the repository

1. Push the repository to GitHub and import it into Vercel.
2. Keep the Vercel project's **Root Directory** at the repository root so it can read `vercel.json` and both service roots.
3. Configure these environment variables for the `server` service in Production and any Preview/Development environments that need to access Supabase:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | Supabase project URL, e.g. `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret `service_role` key |
   | `SUPABASE_ANON_KEY` | Public anon key; optional for the current Express API, but supported by its Supabase helper |

   Do not use a `VITE_` prefix for the service-role key. Vite-prefixed variables are exposed to browser code.
5. Deploy, then check `https://<your-vercel-domain>/health`. It should return `{"status":"ok"}`.

Use `vercel dev` to run both services together locally when testing Vercel service routing.

## 4. Run locally

For the Express API, create a root `.env` file that is not committed to Git:

```dotenv
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<public-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<secret-service-role-key>
```

Confirm the browser project ID and anon key in `client/src/utils/supabase/info.tsx`, then run:

```sh
npm install
npm run dev
```

This starts the API and Vite frontend together. Vite serves the frontend on port 5000 and proxies `/make-server-2fad19e1/...` requests to the Express API on port 3001.

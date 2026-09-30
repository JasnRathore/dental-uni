# Deploying to Vercel with Supabase

This repository contains a Vite/React frontend and an Express API. Supabase provides authentication and the database. The instructions below describe the required deployment wiring; no application or Vercel configuration files have been changed as part of this guide.

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

The repository's current `vercel.json` does not match the package scripts/output directory, and it rewrites API requests to `/api/index` even though there is no `api` function. Before deployment, update the Vercel wiring as follows.

Set the build command to `npm run build:client` and the output directory to `client/build`. The root `package.json` has no `build` script, and Vite writes the client build to `client/build`.

Add a catch-all Vercel Node function at `api/[...slug].js` so the existing Express routes can run as a serverless function:

```js
const app = require('../server/app');

module.exports = (req, res) => {
  if (req.url && req.url.startsWith('/api/')) {
    req.url = req.url.slice(4);
  } else if (req.url === '/api') {
    req.url = '/';
  }

  return app(req, res);
};
```

Update the API rewrites in `vercel.json` to route the existing API prefix and health check through that function, while keeping the SPA fallback last:

```json
{
  "buildCommand": "npm run build:client",
  "outputDirectory": "client/build",
  "rewrites": [
    {
      "source": "/make-server-2fad19e1/:path*",
      "destination": "/api/make-server-2fad19e1/:path*"
    },
    {
      "source": "/health",
      "destination": "/api/health"
    },
    {
      "source": "/((?!api/).*)",
      "destination": "/index.html"
    }
  ]
}
```

The `/api/...` URL prefix is removed by the function before the request reaches Express, preserving the routes mounted in `server/app.js`. Existing frontend requests use `/make-server-2fad19e1/...`, so keep this prefix consistent in the Vercel rewrite.

## 3. Deploy the repository

1. Push the repository to GitHub and import it into Vercel.
2. Set the Vercel project's **Root Directory** to the repository root, not `client`.
3. Use `npm install` as the install command, `npm run build:client` as the build command, and `client/build` as the output directory. The latter two should also be read from the updated `vercel.json`.
4. Add these Vercel environment variables for Production and any Preview/Development environments that need to access Supabase:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | Supabase project URL, e.g. `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret `service_role` key |
   | `SUPABASE_ANON_KEY` | Public anon key; optional for the current Express API, but supported by its Supabase helper |

   Do not use a `VITE_` prefix for the service-role key. Vite-prefixed variables are exposed to browser code.
5. Deploy, then check `https://<your-vercel-domain>/health`. It should return `{"status":"ok"}`.

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

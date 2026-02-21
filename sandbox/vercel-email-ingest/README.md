# Vercel Email Ingest Sandbox

Minimal sandbox to validate:
- IMAP pull (latest email)
- AI extraction to strict JSON
- Optional save into existing Supabase (`inquiries`, `inquiry_items`, `quotations`, `quotation_items`)

This folder is standalone and can be deployed as its own Vercel project.

## 1) Deploy

1. In Vercel, create a new project and set **Root Directory** to:
`sandbox/vercel-email-ingest`
2. Framework can be **Other** (no Next build required).
3. Deploy.

## 2) Environment Variables

Required:
- `IMAP_HOST` (e.g. `imap.exmail.qq.com`)
- `IMAP_PORT` (e.g. `993`)
- `IMAP_SECURE` (`true` or `false`)
- `IMAP_USER`
- `IMAP_PASS`
- `IMAP_MAILBOX` (default `INBOX`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (recommend `gpt-4o-mini`)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SANDBOX_OWNER_USER_ID` (the auth.users.id that owns inserted records)

Optional:
- `SANDBOX_ENDPOINT_TOKEN` (protect `/api/pull-and-parse`; pass via `x-sandbox-token`)

## 3) Use

- Open project URL root `/`
- Click `Pull & Parse Once`
- Keep `Save to Supabase` checked to persist into your main Supabase data.

## 4) Verify in Main App

After `saved` returns with IDs:
- Open local main app quotation list.
- Check returned `quotationId`.

## 5) Merge Strategy

You can copy this entire folder as-is into any repo, or copy only:
- `api/pull-and-parse.ts`
- `api/health.ts`

No schema migration is required.

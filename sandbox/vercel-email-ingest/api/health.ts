export default async function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    service: "vercel-email-ingest-sandbox",
    now: new Date().toISOString(),
  });
}

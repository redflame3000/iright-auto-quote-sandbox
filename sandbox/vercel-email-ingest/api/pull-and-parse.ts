import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import {
  persistDraftToBusinessStore,
  type PersistResult,
} from "../lib/business-store.js";

type ChatCompletionResponsePayload = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

type RawAiDraft = {
  customer?: {
    name?: unknown;
    country?: unknown;
    billing_address?: unknown;
    contact_person?: unknown;
    contact_phone?: unknown;
    contact_email?: unknown;
  };
  delivery?: {
    company_name?: unknown;
    address?: unknown;
    contact_person?: unknown;
    phone?: unknown;
    email?: unknown;
  };
  items?: Array<{
    brand?: unknown;
    catalog_number?: unknown;
    quantity?: unknown;
  }>;
};

function text(input: unknown, fallback = ""): string {
  const v = String(input ?? "").trim();
  return v || fallback;
}

function maybeText(input: unknown): string | null {
  const v = String(input ?? "").trim();
  return v || null;
}

function asQty(input: unknown): number | null {
  const parsed = Number.parseInt(String(input ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeCatalog(input: string): string {
  return input.toUpperCase().replace(/[\s_-]+/g, "");
}

function normalizeSubject(input: string): string {
  return text(input).toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, "").trim();
}

function unauthorized(req: any, res: any): boolean {
  const token = text(process.env.SANDBOX_ENDPOINT_TOKEN);
  if (!token) return false;
  const got = text(req.headers["x-sandbox-token"]);
  if (got === token) return false;
  res.status(401).json({ ok: false, error: "Unauthorized" });
  return true;
}

async function pullLatestEmail() {
  const host = text(process.env.IMAP_HOST);
  const port = Number.parseInt(text(process.env.IMAP_PORT, "993"), 10);
  const secure = text(process.env.IMAP_SECURE, "true").toLowerCase() !== "false";
  const user = text(process.env.IMAP_USER);
  const pass = text(process.env.IMAP_PASS);
  const mailbox = text(process.env.IMAP_MAILBOX, "INBOX");

  if (!host || !user || !pass) {
    throw new Error("Missing IMAP_HOST/IMAP_USER/IMAP_PASS");
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock(mailbox);
    const mailboxInfo = await client.mailboxOpen(mailbox);
    if (!mailboxInfo.exists) {
      throw new Error("Mailbox is empty.");
    }
    const latest = await client.fetchOne(String(mailboxInfo.exists), {
      uid: true,
      source: true,
      envelope: true,
    });
    if (latest === false || !latest.source) {
      throw new Error("Unable to fetch latest message.");
    }
    const source = Buffer.isBuffer(latest.source)
      ? latest.source
      : Buffer.from(latest.source);
    const parsed = await simpleParser(source);
    const from =
      parsed.from?.value?.find((v) => v.address)?.address ||
      latest.envelope?.from?.[0]?.address ||
      "";
    return {
      uid: latest.uid,
      messageId: text(parsed.messageId || latest.envelope?.messageId || ""),
      subject: text(parsed.subject || latest.envelope?.subject || ""),
      subjectNorm: normalizeSubject(text(parsed.subject || latest.envelope?.subject || "")),
      from: text(from).toLowerCase(),
      text: text(parsed.text),
      date: parsed.date?.toISOString() || new Date().toISOString(),
    };
  } finally {
    if (lock) lock.release();
    try {
      if (client.usable) await client.logout();
    } catch {
      // ignore
    }
  }
}

async function aiExtract(mail: { subject: string; from: string; text: string }) {
  const key = text(process.env.OPENAI_API_KEY);
  const model = text(process.env.OPENAI_MODEL, "gpt-4o-mini");
  if (!key) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const prompt = [
    "Extract inquiry data from this email.",
    "Return STRICT JSON only. No markdown, no explanation.",
    "Allowed top-level keys: customer, delivery, items",
    "Allowed customer keys: name, country, billing_address, contact_person, contact_phone, contact_email",
    "Allowed delivery keys: company_name, address, contact_person, phone, email",
    "Allowed item keys: brand, catalog_number, quantity",
    "If uncertain, use null.",
    "",
    `Subject: ${mail.subject}`,
    `From: ${mail.from}`,
    "Body:",
    mail.text.slice(0, 12000),
  ].join("\n");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Output strict JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${body}`);
  }
  const payload = (await resp.json()) as ChatCompletionResponsePayload;
  const content = text(payload?.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("OpenAI returned empty content.");
  }
  const json = JSON.parse(content) as RawAiDraft;
  return { model, json, raw: content };
}

function transformAiToDraft(ai: RawAiDraft) {
  const customer = ai.customer ?? {};
  const delivery = ai.delivery ?? {};
  const items = Array.isArray(ai.items) ? ai.items : [];

  return {
    customer_name: text(customer.name),
    customer_country: text(customer.country),
    billing_address: maybeText(customer.billing_address),
    contact_person: maybeText(customer.contact_person),
    contact_phone: maybeText(customer.contact_phone),
    contact_email: maybeText(customer.contact_email),
    delivery_company_name: maybeText(delivery.company_name),
    delivery_address: maybeText(delivery.address),
    delivery_contact_person: maybeText(delivery.contact_person),
    delivery_phone: maybeText(delivery.phone),
    delivery_email: maybeText(delivery.email),
    lines: items
      .map((line) => {
        const brand = text(line.brand);
        const catalog = text(line.catalog_number);
        const qty = asQty(line.quantity);
        if (!brand || !catalog || qty === null) return null;
        return {
          brandInputUpper: brand.toUpperCase(),
          catalogUpper: catalog.toUpperCase(),
          normalizedCatalog: normalizeCatalog(catalog),
          quantity: qty,
        };
      })
      .filter(
        (v): v is {
          brandInputUpper: string;
          catalogUpper: string;
          normalizedCatalog: string;
          quantity: number;
        } => Boolean(v),
      ),
  };
}

async function persistDraftToStore(
  draft: ReturnType<typeof transformAiToDraft>,
  mail: { uid: number; messageId: string; subjectNorm: string; from: string },
) {
  return await persistDraftToBusinessStore(draft, mail);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  if (unauthorized(req, res)) return;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const save = Boolean(body?.save);

    const mail = await pullLatestEmail();
    const ai = await aiExtract({
      subject: mail.subject,
      from: mail.from,
      text: mail.text,
    });
    const draft = transformAiToDraft(ai.json);

    let saved: PersistResult | null = null;
    if (save) {
      saved = await persistDraftToStore(draft, {
        uid: mail.uid,
        messageId: mail.messageId,
        subjectNorm: mail.subjectNorm,
        from: mail.from,
      });
    }

    res.status(200).json({
      ok: true,
      save,
      mail: {
        uid: mail.uid,
        messageId: mail.messageId,
        subject: mail.subject,
        subjectNorm: mail.subjectNorm,
        from: mail.from,
        textPreview: mail.text.slice(0, 800),
      },
      ai: {
        model: ai.model,
        json: ai.json,
      },
      transformed: draft,
      saved,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      details: {
        name: err?.name || null,
        code: err?.code || null,
        stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 3) : null,
      },
    });
  }
}

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createClient } from "@supabase/supabase-js";

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
  const payload = await resp.json();
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

async function resolveBrand(service: any, brandInputUpper: string) {
  const { data } = await service
    .from("brand_alias")
    .select("standard_brand")
    .eq("alias", brandInputUpper)
    .limit(1)
    .maybeSingle();
  if (!data) return brandInputUpper;
  return text(data.standard_brand, brandInputUpper).toUpperCase();
}

async function saveDraftToSupabase(draft: ReturnType<typeof transformAiToDraft>) {
  const url = text(process.env.SUPABASE_URL);
  const key = text(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const userId = text(process.env.SANDBOX_OWNER_USER_ID);
  if (!url || !key || !userId) {
    throw new Error("Missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SANDBOX_OWNER_USER_ID");
  }
  if (!draft.lines.length) {
    throw new Error("No valid lines to save.");
  }

  const service = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: inquiry, error: inquiryErr } = await service
    .from("inquiries")
    .insert({
      user_id: userId,
      status: "draft",
      customer_name: draft.customer_name,
      customer_country: draft.customer_country,
      billing_address: draft.billing_address,
      contact_person: draft.contact_person,
      contact_phone: draft.contact_phone,
      contact_email: draft.contact_email,
    })
    .select("id")
    .single();
  if (inquiryErr || !inquiry) {
    throw new Error(`Create inquiry failed: ${inquiryErr?.message || "unknown"}`);
  }

  const inquiryItems: Array<{
    id: string;
    brandInputUpper: string;
    brandStandard: string;
    catalogUpper: string;
    normalizedCatalog: string;
    quantity: number;
  }> = [];

  for (const line of draft.lines) {
    const brandStandard = await resolveBrand(service, line.brandInputUpper);
    const { data: inquiryItem, error } = await service
      .from("inquiry_items")
      .insert({
        inquiry_id: inquiry.id,
        user_id: userId,
        brand: brandStandard,
        catalog_number: line.catalogUpper,
        normalized_catalog_number: line.normalizedCatalog,
        quantity: line.quantity,
      })
      .select("id")
      .single();
    if (error || !inquiryItem) {
      throw new Error(`Create inquiry item failed: ${error?.message || "unknown"}`);
    }
    inquiryItems.push({
      id: inquiryItem.id,
      brandInputUpper: line.brandInputUpper,
      brandStandard,
      catalogUpper: line.catalogUpper,
      normalizedCatalog: line.normalizedCatalog,
      quantity: line.quantity,
    });
  }

  const { data: quotation, error: quotationErr } = await service
    .from("quotations")
    .insert({
      inquiry_id: inquiry.id,
      user_id: userId,
      status: "draft",
      template_meta: {
        shipment_company_name: draft.delivery_company_name ?? "",
        shipment_address: draft.delivery_address ?? "",
        shipment_recipient: draft.delivery_contact_person ?? "",
        shipment_phone: draft.delivery_phone ?? "",
        shipment_email: draft.delivery_email ?? "",
      },
    })
    .select("id")
    .single();
  if (quotationErr || !quotation) {
    throw new Error(`Create quotation failed: ${quotationErr?.message || "unknown"}`);
  }

  for (const item of inquiryItems) {
    const { data: hit } = await service
      .from("price_list")
      .select("id")
      .eq("brand", item.brandStandard)
      .eq("normalized_catalog_number", item.normalizedCatalog)
      .maybeSingle();

    const { error } = await service
      .from("quotation_items")
      .insert({
        quotation_id: quotation.id,
        inquiry_item_id: item.id,
        user_id: userId,
        brand: item.brandStandard,
        catalog_number: item.catalogUpper,
        normalized_catalog_number: item.normalizedCatalog,
        quantity: item.quantity,
        price_list_id: hit?.id ?? null,
        match_status: hit?.id ? "matched" : "not_found",
        brand_input: item.brandInputUpper,
        brand_standard: item.brandStandard,
      });
    if (error) {
      throw new Error(`Create quotation item failed: ${error.message}`);
    }
  }

  return { inquiryId: inquiry.id, quotationId: quotation.id };
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

    let saved: { inquiryId: string; quotationId: string } | null = null;
    if (save) {
      saved = await saveDraftToSupabase(draft);
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

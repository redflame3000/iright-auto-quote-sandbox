import { randomUUID } from "node:crypto";

import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";

type DraftLine = {
  brandInputUpper: string;
  catalogUpper: string;
  normalizedCatalog: string;
  quantity: number;
};

type DraftPayload = {
  customer_name: string;
  customer_country: string;
  billing_address: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  delivery_company_name: string | null;
  delivery_address: string | null;
  delivery_contact_person: string | null;
  delivery_phone: string | null;
  delivery_email: string | null;
  lines: DraftLine[];
};

type MailMeta = {
  uid: number;
  messageId: string;
  subjectNorm: string;
  from: string;
};

type StoreConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ownerUserId: string;
};

type ExistingQuotationRow = RowDataPacket & {
  id: string;
  inquiry_id: string;
};

type BrandAliasRow = RowDataPacket & {
  standard_brand: string;
};

type PriceListRow = RowDataPacket & {
  id: string;
};

export type PersistDiagnostics = {
  databaseHost: string;
  databaseName: string;
  ownerUserId: string;
  duplicateSourceMessageId: string | null;
  insertError: string | null;
};

export type PersistResult = {
  ok: boolean;
  inquiryId?: string;
  quotationId?: string;
  duplicated: boolean;
  diagnostics: PersistDiagnostics;
};

function text(input: unknown, fallback = ""): string {
  const value = String(input ?? "").trim();
  return value || fallback;
}

function firstEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = text(process.env[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function requireValue(value: string, name: string): string {
  const normalized = text(value);
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  return normalized;
}

function getStoreConfig(): StoreConfig {
  const host = firstEnv("DATA_DB_HOST", "MYSQL_HOST") || "127.0.0.1";
  const portRaw = firstEnv("DATA_DB_PORT", "MYSQL_PORT") || "3306";
  const port = Number.parseInt(portRaw, 10);

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 3306,
    database: requireValue(
      firstEnv("DATA_DB_DATABASE", "DATA_DB_NAME", "MYSQL_DATABASE"),
      "DATA_DB_DATABASE",
    ),
    user: requireValue(firstEnv("DATA_DB_USER", "MYSQL_USER"), "DATA_DB_USER"),
    password: requireValue(
      firstEnv("DATA_DB_PASSWORD", "MYSQL_PASSWORD"),
      "DATA_DB_PASSWORD",
    ),
    ownerUserId: requireValue(
      firstEnv("DATA_OWNER_USER_ID", "SANDBOX_OWNER_USER_ID"),
      "DATA_OWNER_USER_ID",
    ),
  };
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const config = getStoreConfig();
    pool = createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 5,
      maxIdle: 5,
      idleTimeout: 60_000,
      queueLimit: 0,
      decimalNumbers: true,
    });
  }

  return pool;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function findExistingQuotation(
  connection: PoolConnection,
  userId: string,
  sourceMessageId: string,
): Promise<ExistingQuotationRow | null> {
  if (!sourceMessageId) {
    return null;
  }

  const [rows] = await connection.execute<ExistingQuotationRow[]>(
    `
      SELECT id, inquiry_id
      FROM quotations
      WHERE user_id = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(template_meta, '$.source_message_id')) = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId, sourceMessageId],
  );

  return rows[0] ?? null;
}

async function resolveStandardBrand(
  connection: PoolConnection,
  brandInputUpper: string,
): Promise<string> {
  const [rows] = await connection.execute<BrandAliasRow[]>(
    `
      SELECT standard_brand
      FROM brand_alias
      WHERE alias = ?
      LIMIT 1
    `,
    [brandInputUpper],
  );

  const match = rows[0]?.standard_brand;
  return text(match, brandInputUpper).toUpperCase();
}

async function findPriceListId(
  connection: PoolConnection,
  brandStandard: string,
  normalizedCatalog: string,
): Promise<string | null> {
  const [rows] = await connection.execute<PriceListRow[]>(
    `
      SELECT id
      FROM price_list
      WHERE brand = ?
        AND normalized_catalog_number = ?
      LIMIT 1
    `,
    [brandStandard, normalizedCatalog],
  );

  return text(rows[0]?.id) || null;
}

function buildTemplateMeta(draft: DraftPayload, mail: MailMeta): Record<string, unknown> {
  const hasDeliveryInfo = Boolean(
    draft.delivery_company_name ||
      draft.delivery_address ||
      draft.delivery_contact_person ||
      draft.delivery_phone ||
      draft.delivery_email,
  );

  return {
    ...(hasDeliveryInfo ? { shipment_mode: "CUSTOM" } : {}),
    source_uid: mail.uid,
    source_message_id: text(mail.messageId).toLowerCase() || null,
    source_subject_norm: mail.subjectNorm,
    source_from: mail.from,
    shipment_company_name: draft.delivery_company_name ?? "",
    shipment_address: draft.delivery_address ?? "",
    shipment_recipient: draft.delivery_contact_person ?? "",
    shipment_phone: draft.delivery_phone ?? "",
    shipment_email: draft.delivery_email ?? "",
  };
}

export async function persistDraftToBusinessStore(
  draft: DraftPayload,
  mail: MailMeta,
): Promise<PersistResult> {
  const config = getStoreConfig();
  const sourceMessageId = text(mail.messageId).toLowerCase() || null;
  const diagnostics: PersistDiagnostics = {
    databaseHost: config.host,
    databaseName: config.database,
    ownerUserId: config.ownerUserId,
    duplicateSourceMessageId: sourceMessageId,
    insertError: null,
  };

  if (!draft.lines.length) {
    throw new Error("No valid lines to save.");
  }

  const connection = await getPool().getConnection();
  try {
    const existing = await findExistingQuotation(
      connection,
      config.ownerUserId,
      sourceMessageId ?? "",
    );
    if (existing?.id && existing?.inquiry_id) {
      return {
        ok: true,
        inquiryId: existing.inquiry_id,
        quotationId: existing.id,
        duplicated: true,
        diagnostics,
      };
    }

    await connection.beginTransaction();

    const inquiryId = randomUUID();
    await connection.execute(
      `
        INSERT INTO inquiries (
          id,
          user_id,
          status,
          customer_name,
          customer_country,
          billing_address,
          contact_person,
          contact_phone,
          contact_email
        )
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)
      `,
      [
        inquiryId,
        config.ownerUserId,
        draft.customer_name,
        draft.customer_country,
        draft.billing_address,
        draft.contact_person,
        draft.contact_phone,
        draft.contact_email,
      ],
    );

    const inquiryItems: Array<{
      id: string;
      brandInputUpper: string;
      brandStandard: string;
      catalogUpper: string;
      normalizedCatalog: string;
      quantity: number;
    }> = [];

    for (const line of draft.lines) {
      const inquiryItemId = randomUUID();
      const brandStandard = await resolveStandardBrand(connection, line.brandInputUpper);

      await connection.execute(
        `
          INSERT INTO inquiry_items (
            id,
            inquiry_id,
            user_id,
            brand,
            catalog_number,
            normalized_catalog_number,
            quantity
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          inquiryItemId,
          inquiryId,
          config.ownerUserId,
          brandStandard,
          line.catalogUpper,
          line.normalizedCatalog,
          line.quantity,
        ],
      );

      inquiryItems.push({
        id: inquiryItemId,
        brandInputUpper: line.brandInputUpper,
        brandStandard,
        catalogUpper: line.catalogUpper,
        normalizedCatalog: line.normalizedCatalog,
        quantity: line.quantity,
      });
    }

    const quotationId = randomUUID();
    await connection.execute(
      `
        INSERT INTO quotations (
          id,
          inquiry_id,
          user_id,
          status,
          template_meta
        )
        VALUES (?, ?, ?, 'draft', CAST(? AS JSON))
      `,
      [
        quotationId,
        inquiryId,
        config.ownerUserId,
        JSON.stringify(buildTemplateMeta(draft, mail)),
      ],
    );

    for (const item of inquiryItems) {
      const quotationItemId = randomUUID();
      const priceListId = await findPriceListId(
        connection,
        item.brandStandard,
        item.normalizedCatalog,
      );

      await connection.execute(
        `
          INSERT INTO quotation_items (
            id,
            quotation_id,
            inquiry_item_id,
            user_id,
            brand,
            catalog_number,
            normalized_catalog_number,
            quantity,
            price_list_id,
            match_status,
            brand_input,
            brand_standard
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          quotationItemId,
          quotationId,
          item.id,
          config.ownerUserId,
          item.brandStandard,
          item.catalogUpper,
          item.normalizedCatalog,
          item.quantity,
          priceListId,
          priceListId ? "matched" : "not_found",
          item.brandInputUpper,
          item.brandStandard,
        ],
      );
    }

    await connection.commit();

    return {
      ok: true,
      inquiryId,
      quotationId,
      duplicated: false,
      diagnostics,
    };
  } catch (error) {
    diagnostics.insertError = formatError(error);
    try {
      await connection.rollback();
    } catch {
      // ignore rollback failures
    }
    return {
      ok: false,
      duplicated: false,
      diagnostics,
    };
  } finally {
    connection.release();
  }
}

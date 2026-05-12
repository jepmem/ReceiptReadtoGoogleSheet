import "dotenv/config";
import express from "express";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAccessPage } from "./views/accessPage.js";
import { renderReceiptPage } from "./views/receiptPage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const app = express();
const RECEIPT_UPLOAD_MAX_MB = Number(process.env.RECEIPT_UPLOAD_MAX_MB || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_UPLOAD_MAX_MB * 1024 * 1024 },
});

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
const ID_SHEET_NAME = process.env.GOOGLE_SHEETS_ID_WORKSHEET_NAME || "ID";
const EXPENSE_SHEET_NAME = process.env.GOOGLE_SHEETS_WORKSHEET_NAME || "EXPENSES";
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Bangkok";
const AUTH_COOKIE_NAME = "receipt_auth";
const AUTH_SECRET =
  process.env.AUTH_SECRET || process.env.GEMINI_API_KEY || "receipt-dev-secret";
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 12;

const productSchema = z.object({
  name: z.string(),
  qty: z.string().nullable().optional(),
  total: z.number().nullable(),
  status: z.enum(["Paid", "Unpaid"]).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  paymentType: z.enum(["Cash", "Credit Card", "Online Banking"]).nullable().optional(),
});

const expenseSchema = z.object({
  products: z.array(productSchema),
  total: z.number().nullable(),
  status: z.enum(["Paid", "Unpaid"]).nullable(),
  dueDate: z.string().nullable(),
  paymentType: z.enum(["Cash", "Credit Card", "Online Banking"]).nullable(),
});

const nullableStringSchema = { type: Type.STRING, nullable: true };
const nullableNumberSchema = { type: Type.NUMBER, nullable: true };
const expenseSheetHeaders = [
  "Date",
  "Product",
  "Qty",
  "Price",
  "Status",
  "Due Date",
  "Payment_Type",
];

const expenseResponseSchema = {
  type: Type.OBJECT,
  properties: {
    products: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          qty: nullableStringSchema,
          total: nullableNumberSchema,
        },
        required: ["name", "total"],
        propertyOrdering: ["name", "qty", "total"],
      },
    },
    total: nullableNumberSchema,
    status: {
      type: Type.STRING,
      enum: ["Paid", "Unpaid"],
      nullable: true,
    },
    dueDate: nullableStringSchema,
    paymentType: {
      type: Type.STRING,
      enum: ["Cash", "Credit Card", "Online Banking"],
      nullable: true,
    },
  },
  required: ["products", "total", "status", "dueDate", "paymentType"],
  propertyOrdering: ["products", "total", "status", "dueDate", "paymentType"],
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJsonMessage(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function getGeminiErrorDetails(error) {
  const rawMessage =
    error instanceof Error ? error.message : "Unknown server error.";
  const parsed = parseJsonMessage(rawMessage);
  const apiError = parsed?.error || parsed;

  return {
    code: apiError?.code || error?.status || error?.code,
    status: apiError?.status || error?.status,
    message: apiError?.message || rawMessage,
  };
}

function isRetryableGeminiError(error) {
  const { code, status } = getGeminiErrorDetails(error);
  return code === 429 || code === 500 || code === 503 || status === "UNAVAILABLE";
}

function getClientError(error) {
  const details = getGeminiErrorDetails(error);

  if (
    details.code === 404 &&
    String(details.message || "").includes("Requested entity was not found")
  ) {
    return {
      httpStatus: 500,
      message: `Google Sheet was not found or is not shared with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}. Check GOOGLE_SHEETS_SPREADSHEET_ID and share the Sheet with the service account as an editor.`,
    };
  }

  if (
    details.code === 400 &&
    String(details.message || "").toLowerCase().includes("unable to parse range")
  ) {
    return {
      httpStatus: 500,
      message: `Google Sheet tab was not found. Check GOOGLE_SHEETS_ID_WORKSHEET_NAME (${ID_SHEET_NAME}) and GOOGLE_SHEETS_WORKSHEET_NAME (${EXPENSE_SHEET_NAME}).`,
    };
  }

  if (details.code === 503 || details.status === "UNAVAILABLE") {
    return {
      httpStatus: 503,
      message:
        "Gemini model is temporarily busy. Please wait a moment and try again.",
    };
  }

  if (details.code === 429 || details.status === "RESOURCE_EXHAUSTED") {
    return {
      httpStatus: 429,
      message:
        "Gemini quota or rate limit was reached. Please wait and try again, or check your AI Studio quota.",
    };
  }

  return {
    httpStatus: 500,
    message: details.message,
  };
}

function getHealthStatus() {
  return {
    ok: true,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    receiptUploadMaxMb: RECEIPT_UPLOAD_MAX_MB,
    googleSheetsConfigured: Boolean(
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID &&
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
        process.env.GOOGLE_PRIVATE_KEY
    ),
  };
}

function getGoogleAuth() {
  const clientEmail = requiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = requiredEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        return [
          decodeURIComponent(cookie.slice(0, index)),
          decodeURIComponent(cookie.slice(index + 1)),
        ];
      })
  );
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("base64url");
}

function createAuthToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      name: user.name,
      issuedAt: Date.now(),
    })
  ).toString("base64url");

  return `${payload}.${signPayload(payload)}`;
}

function verifyAuthToken(token) {
  const [payload, signature] = String(token || "").split(".");

  if (!payload || !signature || signPayload(payload) !== signature) {
    return null;
  }

  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const ageMs = Date.now() - Number(user.issuedAt || 0);

    if (ageMs > AUTH_MAX_AGE_SECONDS * 1000) {
      return null;
    }

    return user;
  } catch {
    return null;
  }
}

function getAuthUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAuthToken(cookies[AUTH_COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  const user = getAuthUser(req);

  if (user) {
    req.user = user;
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Your sign-in expired. Please sign in again." });
  }

  return res.redirect("/");
}

function uploadReceipt(req, res, next) {
  upload.single("receipt")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? `Receipt image is too large. Upload an image under ${RECEIPT_UPLOAD_MAX_MB} MB.`
          : error.message;

      return res.status(400).json({ error: message });
    }

    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to read the uploaded file.",
    });
  });
}

function setAuthCookie(res, user) {
  const token = createAuthToken(user);
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: AUTH_MAX_AGE_SECONDS * 1000,
  });
}

async function findUserByPass(pass) {
  const spreadsheetId = requiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheets = getSheetsClient();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ID_SHEET_NAME}!A:C`,
  });
  const rows = result.data.values || [];

  for (const row of rows) {
    const [id, name, storedPass] = row;

    if (String(storedPass || "").trim() === String(pass || "").trim()) {
      return {
        id: String(id || "").trim(),
        name: String(name || "").trim(),
      };
    }
  }

  return null;
}

async function ensureSheetHeader(sheets, spreadsheetId, sheetName) {
  const headerRange = `${sheetName}!A1:G1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange,
  });
  const existingHeader = existing.data.values?.[0] || [];
  const headerMatches =
    existingHeader.length === expenseSheetHeaders.length &&
    expenseSheetHeaders.every((header, index) => existingHeader[index] === header);

  if (headerMatches) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: headerRange,
    valueInputOption: "RAW",
    requestBody: {
      values: [expenseSheetHeaders],
    },
  });
}

async function getSheetId(sheets, spreadsheetId, sheetName) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const sheet = spreadsheet.data.sheets?.find(
    (item) => item.properties?.title === sheetName
  );

  if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) {
    throw new Error(`Sheet "${sheetName}" was not found.`);
  }

  return sheet.properties.sheetId;
}

function parseUpdatedRowRange(updatedRange) {
  const match = String(updatedRange || "").match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);

  if (!match) {
    return null;
  }

  return {
    startRow: Number(match[1]),
    endRow: Number(match[2]),
  };
}

async function formatSubmittedRows(sheets, spreadsheetId, sheetName, rows, updatedRange) {
  const rowRange = parseUpdatedRowRange(updatedRange);

  if (!rowRange) {
    return;
  }

  const sheetId = await getSheetId(sheets, spreadsheetId, sheetName);
  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowRange.startRow - 1,
          endRowIndex: rowRange.endRow,
          startColumnIndex: 7,
          endColumnIndex: 8,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { bold: false },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold",
      },
    },
  ];
  const totalRowOffset = rows.findIndex((row) => row[7] === "Total");

  if (totalRowOffset >= 0) {
    const totalRowIndex = rowRange.startRow - 1 + totalRowOffset;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: totalRowIndex,
          endRowIndex: totalRowIndex + 1,
          startColumnIndex: 7,
          endColumnIndex: 8,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 0 },
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat",
      },
    });
  }

  rows.forEach((row, index) => {
    if (String(row[4] || "").toLowerCase() !== "unpaid") {
      return;
    }

    const rowIndex = rowRange.startRow - 1 + index;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: 4,
          endColumnIndex: 5,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.86, green: 0.2, blue: 0.25 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
          },
        },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat",
      },
    });
  });

  if (!requests.length) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

function formatSheetDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";

  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function getExpenseProducts(expense) {
  if (expense.products.length) {
    return expense.products.map((product) => ({
      ...product,
      qty: product.qty || "1",
    }));
  }

  return [{ name: "", qty: "1", total: expense.total }];
}

function getExpenseTotal(expense) {
  if (expense.total !== null && expense.total !== undefined) {
    return expense.total;
  }

  const productTotal = getExpenseProducts(expense).reduce((sum, product) => {
    const price = Number(product.total);
    return Number.isFinite(price) ? sum + price : sum;
  }, 0);

  return productTotal ? Number(productTotal.toFixed(2)) : null;
}

function buildSheetRows(expense, submittedAt = formatSheetDate()) {
  const rows = getExpenseProducts(expense).map((product) => [
    submittedAt,
    product.name,
    product.qty ?? "",
    product.total ?? expense.total ?? "",
    product.status ?? expense.status ?? "",
    (product.status ?? expense.status) === "Unpaid"
      ? product.dueDate ?? expense.dueDate ?? ""
      : "",
    product.paymentType ?? expense.paymentType ?? "Cash",
    "",
    "",
  ]);
  const total = getExpenseTotal(expense);

  if (total !== null) {
    if (!rows.length) {
      rows.push(["", "", "", "", "", "", "", "", ""]);
    }

    rows[rows.length - 1][7] = "Total";
    rows[rows.length - 1][8] = total;
  }

  return rows;
}

function buildSheetPreview(expense) {
  return {
    headers: expenseSheetHeaders,
    rows: getExpenseProducts(expense).map((product) => [
      "Created when submitted",
      product.name,
      product.qty ?? "",
      product.total ?? expense.total ?? "",
      product.status ?? expense.status ?? "",
      (product.status ?? expense.status) === "Unpaid"
        ? product.dueDate ?? expense.dueDate ?? ""
        : "",
      product.paymentType ?? expense.paymentType ?? "Cash",
    ]),
    total: getExpenseTotal(expense),
  };
}

function isDiscountProduct(product) {
  const name = String(product?.name || "").trim().toLowerCase();
  const total = Number(product?.total);

  return (
    /^-+$/.test(name) ||
    /\b(discount|promo|promotion|coupon|voucher|markdown)\b/.test(name) ||
    (Number.isFinite(total) && total < 0 && !name)
  );
}

function removeDiscountProducts(expense) {
  return expenseSchema.parse({
    ...expense,
    products: (expense.products || []).filter((product) => !isDiscountProduct(product)),
  });
}

function parseMoney(value) {
  // OCR sometimes drops the decimal point: "$135.99" arrives as "$135 99".
  // Repair that pattern (currency-or-digit then space then exactly 2 digits) so
  // we don't grab the trailing fragment as the amount.
  const str = String(value || "").replace(/([$€£฿]?\s*\d[\d,]*)\s+(\d{2}\b)/g, "$1.$2");
  const matches = str.match(/-?\d[\d,]*(?:[.,]\d{1,2})?/g);

  if (!matches?.length) {
    return null;
  }

  const normalized = matches[matches.length - 1]
    .replace(/,/g, ".")
    .replace(/\.(?=.*\.)/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function getMoneyMatches(value) {
  return Array.from(
    String(value || "").matchAll(/[$โฌยฃเธฟ]\s*-?\d[\d,]*(?:[.,]\d{1,2})?|-?\d[\d,]*[.,]\d{2}/g)
  );
}

function normalizeOcrText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findTotal(lines) {
  const totalWords = /^(grand\s*)?total\b|^total\s*to\s*pay\b|^amount\s*due\b|^balance\b|^net\s*amount\b|^takeaway\s+total\b|^take[-\s]?out\s+total\b/i;
  // ignoredWords: skip summary/tax lines and "TOTAL includes GST" style lines
  const ignoredWords = /subtotal|sub\s*total|tax|vat|change|cash|payment\s*per\s*guest|\bgst\b|\bdiscounts?\b|\bsavings?\b/i;
  const found = scanForTotal(lines, totalWords, ignoredWords);
  if (found !== null) return found;

  // Fallback: some receipts (e.g. Watsons) only label the bottom line as SUBTOTAL.
  // Use it only when no TOTAL was found at all.
  const subtotalWords = /^\d*\s*subtotal\b|^sub\s*total\b/i;
  const subtotalIgnored = /tax|vat|change|cash|\bgst\b/i;
  return scanForTotal(lines, subtotalWords, subtotalIgnored);
}

function scanForTotal(lines, totalWords, ignoredWords) {

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (totalWords.test(line) && !ignoredWords.test(line)) {
      // Bare "TOTAL" with no colon/$/digit can be either:
      //   1. A column header in a GST/tax-breakdown table (NOT the real total) — skip.
      //   2. The actual total label with the amount on an adjacent line — keep.
      // Distinguish by checking immediate neighbors: if neither has a price-only
      // line, it's a column header and we should skip to the next totalWords match.
      const isBareTotal = line.trim().length < 8 && !/[:$0-9]/.test(line);
      if (isBareTotal) {
        const prevLineCheck = index > 0 ? lines[index - 1] : null;
        const nextLineCheck = lines[index + 1];
        const prevPriceOnly = prevLineCheck && isPriceOnlyLine(prevLineCheck);
        const nextPriceOnly = nextLineCheck && isPriceOnlyLine(nextLineCheck);
        if (!prevPriceOnly && !nextPriceOnly) {
          continue;
        }
      }
      // Use strict money matching (requires currency symbol or 2 decimal places)
      // to avoid picking up item counts like "Total (10 items)"
      const strictMatches = getMoneyMatches(line);
      const amount = strictMatches.length
        ? parseMoney(strictMatches[strictMatches.length - 1][0])
        : null;

      if (amount !== null) {
        return amount;
      }

      // Find prev candidate (tilted receipt — amount appears before label in Y-order).
      const prevLine = index > 0 ? lines[index - 1] : null;
      let prevAmount = null;
      if (prevLine && isPriceOnlyLine(prevLine) && /[.,]\d/.test(prevLine)) {
        const prevStrictMatches = getMoneyMatches(prevLine);
        const pv = prevStrictMatches.length
          ? parseMoney(prevStrictMatches[prevStrictMatches.length - 1][0])
          : null;
        if (pv !== null && pv > 0) prevAmount = pv;
      }

      // Find next-line candidate (standard layout — amount comes after label).
      // Reject negative values (discount lines) and skip interim ignored labels.
      let nextAmount = null;
      for (let lookAhead = 1; lookAhead <= 3; lookAhead += 1) {
        const candidate = lines[index + lookAhead];
        if (!candidate) break;
        if (ignoredWords.test(candidate)) continue;
        const cm = getMoneyMatches(candidate);
        const ca = cm.length ? parseMoney(cm[cm.length - 1][0]) : null;
        if (ca !== null && ca > 0) {
          nextAmount = ca;
          break;
        }
      }

      // When both sides have valid candidates, the larger one is usually the receipt
      // total (small prev value tends to be the last product's line price). Otherwise
      // prefer prev (matches tilted receipts where the total is read before its label).
      if (prevAmount !== null && nextAmount !== null && nextAmount > prevAmount * 1.5) {
        return nextAmount;
      }
      if (prevAmount !== null) return prevAmount;
      if (nextAmount !== null) return nextAmount;
    }
  }

  return null;
}

function isAmountOnly(line) {
  return /^[^\d-]*-?\d[\d,.]*[.,]\d{2}$/.test(String(line || "").trim());
}

function cleanProductName(line) {
  return String(line || "")
    .replace(/^[#^*\s]+/g, "")
    .replace(/^[AH]{1,2}(?=Coca\b|Pocky\b|M&Ms\b)/i, "")
    // Strip leading SKU codes: 4+ digits followed by space (Watsons, supermarket POS)
    .replace(/^\d{4,}\s+/, "")
    .replace(/[#^*]+/g, "")
    .replace(/[$โฌยฃเธฟ]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanLineItemName(line) {
  return cleanProductName(line)
    .replace(/\b\d+\s*@\s*[$โฌยฃเธฟ]?\s*\d[\d,.]*/gi, "")
    .replace(/\b[a-z]\s+(?=\d+\s*x)/gi, "")
    .replace(/^\d+\s+(?=\d+\s*(?:pk|x))/i, "")
    .replace(/\s+[({[]?P[)}\]]?\s*$/i, "")
    // Strip "Why Pay $X.XX?" promotional tag (Chemist Warehouse style)
    .replace(/\s*\bwhy\s+pay\s+\S+\s*\??/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseCodeLineItem(line) {
  const value = String(line || "").trim();
  const codeMatch = value.match(/\([A-Za-z0-9]{2,}\)\s+/);

  if (!codeMatch) {
    return null;
  }

  const itemText = value.slice(codeMatch.index).trim();
  const moneyMatches = getMoneyMatches(itemText);

  if (!moneyMatches.length) {
    return null;
  }

  const lastMoneyMatch = moneyMatches[moneyMatches.length - 1];
  const total = parseMoney(lastMoneyMatch[0]);

  if (total === null) {
    return null;
  }

  const beforeTotal = itemText.slice(0, lastMoneyMatch.index).trim();
  // Require space (or string start) before the qty digits โ€” otherwise "$9.90" at the
  // end of beforeTotal would match its own trailing "90" as the qty.
  const qtyMatch = beforeTotal.match(/(?:^|\s)(\d{1,3})\s*$/);
  const qty = qtyMatch?.[1] || "1";
  const beforeQty = qtyMatch ? beforeTotal.slice(0, qtyMatch.index).trim() : beforeTotal;
  const unitMoneyMatches = getMoneyMatches(beforeQty);
  const lastUnitMoneyMatch = unitMoneyMatches[unitMoneyMatches.length - 1];
  const name = lastUnitMoneyMatch
    ? beforeQty.slice(0, lastUnitMoneyMatch.index).trim()
    : beforeQty;

  return createProduct(name, qty, total);
}

function shouldJoinPendingName(pendingName, name) {
  if (!pendingName || !name) {
    return false;
  }

  return (
    /^[a-z]?\s*\d+\s*x/i.test(name) ||
    /^\d+\s*(?:pk|x|ml|g|kg|l)\b/i.test(name) ||
    /^\d+\s+\w+/i.test(name) ||
    name.length < 12
  );
}

function isPackageFragment(name) {
  const value = String(name || "").trim();
  // Multi-word strings are product names, not pure package descriptors. Guards both
  // reversed OCR fragments like "95G SCALE SHRIMP PASTE" and product names that
  // happen to start with a quantity token like "1x Chick N'Roll".
  if (value.split(/\s+/).length >= 2) {
    return false;
  }
  return /^[a-z]?\s*\d+\s*x/i.test(value) || /^\d+\s*(?:pk|x|ml|g|kg|l)\b/i.test(value);
}

function isSummaryLine(line) {
  // Note: do NOT match `^tax\b` — many receipts open with "TAX INVOICE" / "TAX ID"
  // at the very top, which would cut off the entire product list.
  return /\bsubtotal\b|sub\s*total|^rounding\b|^total\b|^cash\b|^change\b|^gst\b|served\s+by|receipt\s+number|loyalty|member|^\d+\s+items?\b/i.test(
    String(line || "")
  );
}

// Strip non-product noise from a continuation/prefix string before appending it to
// a product name. Handles pager messages ("When beep and flash") and brand-logo
// shards (leading runs of all-uppercase short tokens like "M", "YA", "ATCHA").
function stripContinuationNoise(value) {
  return String(value || "")
    .replace(
      /\b(?:please\s+take\s+the\s+meal|when\s+beep\s+and\s+flash|beep\s+and\s+flash|take\s+the\s+meal)\b/gi,
      ""
    )
    .replace(/^(?:[A-Z]{1,5}\s+)+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isQuantityLine(line) {
  const value = String(line || "").trim();
  return (
    /^(?:qty\s*)?\d+\s*@\b/i.test(value) ||
    /^qty\s+\d+$/i.test(value) ||
    /^\d+\s+x\b/i.test(value) ||
    /\beach\b/i.test(value) ||
    /@/.test(value) ||
    /^[\d\s@xX$โฌยฃเธฟ.,-]+$/.test(value)
  );
}

function parseQuantity(line) {
  const value = String(line || "").trim();
  const explicitMatch = value.match(/^qty\s+(\d+)$/i);
  const explicitWithDetailMatch = value.match(/^qty\.?\s*(\d+)/i);
  const unitMatch = value.match(/^(?:qty\s*)?(\d+)\s*(?:@|x\b)/i);
  const compactUnitMatch = value.match(/^(\d)\d\s+\D?\d[\d,.]*/);
  return explicitMatch?.[1] || explicitWithDetailMatch?.[1] || unitMatch?.[1] || compactUnitMatch?.[1] || null;
}

function isMetadataLine(line, name = "") {
  const value = String(line || "").trim();
  const cleanedName = cleanLineItemName(name);

  return (
    /\beach\b/i.test(value) ||
    /@/.test(value) ||
    /^qty\b/i.test(value) ||
    cleanedName.toLowerCase() === "each" ||
    /^\d+$/.test(cleanedName)
  );
}

function hasMetadataTokens(line) {
  const value = String(line || "").trim();
  return /\beach\b/i.test(value) || /@/.test(value) || /^qty\b/i.test(value);
}

function isPriceOnlyLine(line) {
  const value = String(line || "").trim();
  return getMoneyMatches(value).length > 0 && /^[^\p{L}]*[$โฌยฃเธฟ]?\s*-?\d[\d,.]*[^\p{L}]*$/u.test(value);
}

function getRowsLayout(rows) {
  const items = rows.flatMap((row) => row.items || []);

  if (!items.length) {
    return { hasPositions: false, rightPriceStart: 0 };
  }

  const minX = Math.min(...items.map((item) => item.x1));
  const maxX = Math.max(...items.map((item) => item.x2));
  const span = Math.max(1, maxX - minX);
  const roughPriceStart = minX + span * 0.62;
  const rightMoneyItems = items
    .filter((item) => parseMoney(item.text) !== null)
    .filter((item) => item.x1 >= roughPriceStart)
    .sort((left, right) => left.x1 - right.x1);

  if (rightMoneyItems.length) {
    const medianIndex = Math.floor(rightMoneyItems.length / 2);
    const medianPriceX = rightMoneyItems[medianIndex].x1;

    return {
      hasPositions: true,
      rightPriceStart: Math.max(roughPriceStart, medianPriceX - span * 0.12),
    };
  }

  return {
    hasPositions: true,
    rightPriceStart: minX + span * 0.72,
  };
}

function getRightAlignedMoney(row, layout) {
  const items = row.items || [];

  if (layout.hasPositions && items.length) {
    const candidates = items
      .map((item, index) => ({
        item,
        index,
        amount: parseMoney(item.text),
      }))
      .filter((candidate) => candidate.amount !== null)
      .filter((candidate) => candidate.item.x1 >= layout.rightPriceStart)
      // Require currency symbol or decimal — otherwise tax markers ("T") and bare
      // qty digits ("1") get picked as the right-aligned price.
      .filter((candidate) => /[$€£฿]|\d[.,]\d/.test(candidate.item.text))
      .sort((left, right) => right.item.x1 - left.item.x1);
    const [candidate] = candidates;

    if (!candidate) {
      return null;
    }

    const nameText = items
      .slice(0, candidate.index)
      .map((item) => item.text)
      .join(" ");

    if (hasMetadataTokens(nameText)) {
      return {
        amount: candidate.amount,
        nameText,
        isMetadataPriced: true,
        isPriceOnly: false,
      };
    }

    return {
      amount: candidate.amount,
      nameText,
      isMetadataPriced: false,
      isPriceOnly: items.length === 1,
    };
  }

  const moneyMatches = getMoneyMatches(row.text);
  const amountMatch = moneyMatches[moneyMatches.length - 1];

  if (!amountMatch) {
    return null;
  }

  return {
    amount: parseMoney(amountMatch[0]),
    nameText: String(row.text || "").slice(0, amountMatch.index),
    isMetadataPriced: hasMetadataTokens(String(row.text || "").slice(0, amountMatch.index)),
    isPriceOnly: isPriceOnlyLine(row.text),
  };
}

function getRowProductText(row, priceInfo = null) {
  if (priceInfo) {
    return priceInfo.nameText || "";
  }

  return row.text || "";
}

function joinProductParts(parts) {
  return cleanLineItemName(parts.filter(Boolean).join(" "));
}

function cleanContinuationPart(line) {
  return cleanLineItemName(line)
    .replace(/^[a-z]\s+(?=[A-Z0-9])/g, "")
    .replace(/^0\s+(?=[A-Z])/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function createProduct(name, qty, total) {
  const cleanName = cleanLineItemName(name);

  if (
    cleanName.length < 2 ||
    total === null ||
    total === undefined ||
    isSummaryLine(cleanName) ||
    isQuantityLine(cleanName) ||
    isMetadataLine("", cleanName) ||
    isPackageFragment(cleanName)
  ) {
    return null;
  }

  return {
    name: cleanName,
    qty: qty || "1",
    total,
  };
}

function normalizeParsedProducts(products, receiptTotal) {
  const productCount = products.length;

  return products
    .map((product) => ({
      ...product,
      name: cleanLineItemName(product.name),
      qty: product.qty || "1",
    }))
    .filter((product) => product.name.length >= 2)
    .filter((product) => !isSummaryLine(product.name))
    .filter((product) => !isQuantityLine(product.name))
    .filter((product) => !isMetadataLine("", product.name))
    .filter((product) => {
      if (receiptTotal === null || receiptTotal === undefined) {
        return true;
      }

      const amount = Number(product.total);
      // Keep amounts <= total (single-item receipts have amount == total).
      // Phantom "TOTAL" lines with name matching summary keywords are already
      // filtered by the earlier isSummaryLine check.
      return !Number.isFinite(amount) || amount <= receiptTotal || productCount === 1;
    });
}

function estimateDocumentTilt(entries) {
  // Estimate slope (dy/dx) of text lines from pairs of entries likely on the same line
  const slopes = [];
  const limit = Math.min(entries.length, 80);

  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const a = entries[i];
      const b = entries[j];
      const dx = b.x1 - a.x1;
      const dy = b.centerY - a.centerY;
      const avgHeight = (a.height + b.height) / 2;

      // Same-line pair: significant horizontal gap, small vertical gap relative to text height
      if (Math.abs(dx) > avgHeight * 3 && Math.abs(dy) < avgHeight * 1.5) {
        slopes.push(dy / dx);
      }
    }
  }

  if (slopes.length < 5) {
    return 0;
  }

  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)];
}

function getOcrRows(entries) {
  const positioned = (entries || [])
    .filter((entry) => entry?.text && Array.isArray(entry.box) && entry.box.length === 4)
    .map((entry) => {
      const [x1, y1, x2, y2] = entry.box.map(Number);
      return {
        text: String(entry.text).trim(),
        x1,
        x2,
        y1,
        y2,
        centerY: (y1 + y2) / 2,
        height: Math.max(1, y2 - y1),
      };
    })
    .filter((entry) =>
      [entry.x1, entry.x2, entry.y1, entry.y2].every((value) => Number.isFinite(value))
    );

  if (!positioned.length) {
    return [];
  }

  // Correct for document tilt so left-column names and right-column prices
  // on the same receipt line are grouped into the same row
  const tilt = estimateDocumentTilt(positioned);

  const sorted = positioned
    .map((entry) => ({
      ...entry,
      correctedY: entry.centerY - tilt * (entry.x1 + entry.x2) / 2,
    }))
    .sort((a, b) => a.correctedY - b.correctedY || a.x1 - b.x1);

  const rows = [];

  for (const entry of sorted) {
    const lastRow = rows[rows.length - 1];
    const tolerance = Math.max(3, entry.height * 0.6);

    if (!lastRow || Math.abs(lastRow.correctedY - entry.correctedY) > tolerance) {
      rows.push({
        centerY: entry.centerY,
        correctedY: entry.correctedY,
        items: [entry],
      });
      continue;
    }

    lastRow.items.push(entry);
    lastRow.correctedY =
      lastRow.items.reduce((sum, item) => sum + item.correctedY, 0) / lastRow.items.length;
    lastRow.centerY =
      lastRow.items.reduce((sum, item) => sum + item.centerY, 0) / lastRow.items.length;
  }

  return rows.map((row) => {
    const items = row.items.sort((left, right) => left.x1 - right.x1);
    return {
      text: items.map((item) => item.text).join(" ").replace(/\s{2,}/g, " ").trim(),
      items,
    };
  });
}

function getCandidateRows(lines, entries) {
  const positionedRows = getOcrRows(entries);
  const rows = positionedRows.length
    ? positionedRows
    : lines.map((line) => ({ text: line, items: [] }));
  const dateIndex = rows.findIndex((row) =>
    /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\bdate\b/i.test(row.text)
  );
  // Only use date as a "skip header" boundary when it's near the top — some
  // receipts (e.g. Chemist Warehouse) print Date/Time in the payment block at
  // the very bottom, which would otherwise truncate the entire product list.
  const startIndex = dateIndex >= 0 && dateIndex < rows.length / 2 ? dateIndex + 1 : 0;
  // Boundary uses STRICTER terminal markers than isSummaryLine (which also matches
  // SUBTOTAL). Some receipts have a product line *after* an intermediate SUBTOTAL
  // (e.g. redemption rows on Watsons), so we should keep going until we hit a real
  // tail-end marker like CASH/CHANGE/CARD/GST or "VAT RECEIPT SUMMARY".
  const terminalMarker = /^cash\b|^change\b|^card\b|^gst\b|^trans?fer\b|^eft\b|^total\s+discounts?\b|^vat\s+receipt\b|receipt\s+number|you\s+have\s+saved|^promptpay\b|^net\s+total\b|^take[-\s]?out\s+total|^takeaway\s+total\b|^orki?\b/i;
  const summaryIndex = rows.findIndex(
    (row, index) => index >= startIndex && terminalMarker.test(row.text)
  );
  const endIndex = summaryIndex >= 0 ? summaryIndex : rows.length;

  return rows.slice(startIndex, endIndex);
}

function extractProductsFromRows(rows, skipWords) {
  const products = [];
  let pendingNameParts = [];
  let pendingQty = null;
  let lastProduct = null;
  // Only append continuation lines after a code-prefixed line item was seen, so
  // receipts without code prefixes (where every line is a separate product) aren't
  // affected โ€” their non-amount rows shouldn't be merged into the previous product.
  let lastFromCodeLine = false;
  const layout = getRowsLayout(rows);

  for (const row of rows) {
    const line = String(row.text || "").trim();

    if (!line || skipWords.test(line) || isSummaryLine(line)) {
      continue;
    }

    // "(N x $UNIT)" — qty/unit-pricing line that belongs to the previous product
    // (e.g. "(2 x $85.00)" under "Egg Tart $170.00"). Update qty, don't make a product.
    const qtyOnlyMatch = line.match(/^\(\s*(\d+)\s*x\s*\$?[\d.,]+\s*\)/i);
    if (qtyOnlyMatch && lastProduct) {
      lastProduct.qty = qtyOnlyMatch[1];
      continue;
    }

    // If a code-prefixed line item is preceded by text on the same row, that prefix
    // is usually the previous product's continuation (e.g. "Takeaway, No sugar] (Sf03) ...").
    const codeMatchOnLine = line.match(/\([A-Za-z0-9]{2,}\)\s+/);
    if (codeMatchOnLine && codeMatchOnLine.index > 0 && lastProduct && lastFromCodeLine) {
      const prefix = stripContinuationNoise(cleanLineItemName(line.slice(0, codeMatchOnLine.index)));
      if (prefix && prefix.length >= 2 && !isQuantityLine(prefix) && !isMetadataLine("", prefix)) {
        lastProduct.name = `${lastProduct.name} ${prefix}`.trim();
      }
    }

    const codeLineProduct = parseCodeLineItem(line);

    if (codeLineProduct) {
      products.push(codeLineProduct);
      lastProduct = codeLineProduct;
      lastFromCodeLine = true;
      pendingNameParts = [];
      pendingQty = null;
      continue;
    }

    // Non-code row with no amount and a recent code-line product โ’ treat as
    // continuation of that product's name (e.g. "Matcha Straight [Ice," after "(M01) Single Origin").
    if (lastFromCodeLine && lastProduct && pendingNameParts.length === 0) {
      const priceInfoForContinuation = getRightAlignedMoney(row, layout);
      if (!priceInfoForContinuation) {
        const cleaned = stripContinuationNoise(cleanLineItemName(line));
        if (cleaned && cleaned.length >= 2 && !isQuantityLine(cleaned) && !isMetadataLine("", cleaned)) {
          lastProduct.name = `${lastProduct.name} ${cleaned}`.trim();
          continue;
        }
      }
    }

    const priceInfo = getRightAlignedMoney(row, layout);
    const amount = priceInfo?.amount ?? null;
    const qty = parseQuantity(line);
    const leftText = cleanLineItemName(getRowProductText(row, priceInfo));
    const metadataLine =
      isQuantityLine(line) ||
      hasMetadataTokens(line) ||
      priceInfo?.isMetadataPriced ||
      isMetadataLine(line, leftText);

    if (amount === null && qty && metadataLine) {
      pendingQty = qty;

      if (!pendingNameParts.length && lastProduct) {
        lastProduct.qty = qty;
        pendingQty = null;
      }

      continue;
    }

    if (amount === null) {
      // After a priced product, a follow-up row that's "<qty> <name>" with no price
      // is usually a bundle/value-meal sub-item (e.g. "1 M French Fries - 3WK").
      // Capture as a $0 product so it shows up in the parsed list.
      if (lastProduct && !metadataLine) {
        const subItemMatch = line.match(/^(\d+)\s+(\S.+)$/);
        if (subItemMatch) {
          const subName = cleanLineItemName(subItemMatch[2]);
          // Skip generic count words like "Item(s)" which are summary labels, not products
          if (subName && subName.length >= 2 && !/^items?\b|^item\(s\)$/i.test(subName)) {
            const subProduct = createProduct(subName, subItemMatch[1], 0);
            if (subProduct) {
              products.push(subProduct);
              lastProduct = subProduct;
              lastFromCodeLine = false;
              continue;
            }
          }
        }

        // Coles-style product line "*% NAME ... .800" where OCR mangled the price.
        // Capture the name as $0 — reconcile may later fill in the missing amount.
        if (/^[*%]+\s*\S/.test(line)) {
          const cleanedName = cleanLineItemName(line.replace(/^[*%\s]+/, ""))
            .replace(/\s+[\d.,]+\s*$/, "")
            .trim();
          if (cleanedName.length >= 3) {
            const product = createProduct(cleanedName, "1", 0);
            if (product) {
              products.push(product);
              lastProduct = product;
              lastFromCodeLine = false;
              continue;
            }
          }
        }
      }

      if (!metadataLine) {
        const name = cleanLineItemName(line);

        if (name) {
          pendingNameParts.push(name);
        }
      }

      continue;
    }

    // When a row has substantial leftText alongside its own amount, treat it as
    // self-contained — drop accumulated pendingNameParts which is usually leftover
    // header noise (store name, column labels) that couldn't be filtered individually.
    const isSelfContained =
      leftText &&
      leftText.length >= 3 &&
      !metadataLine &&
      !isPackageFragment(leftText);
    const nameParts = isSelfContained ? [leftText] : [...pendingNameParts];

    if (!isSelfContained && leftText && (!metadataLine || isPackageFragment(leftText))) {
      nameParts.push(leftText);
    }

    const product = createProduct(joinProductParts(nameParts), qty || pendingQty, amount);

    if (product) {
      products.push(product);
      lastProduct = product;
      lastFromCodeLine = false;
      pendingNameParts = [];
      pendingQty = null;
      continue;
    }

    if (qty && lastProduct && metadataLine) {
      lastProduct.qty = qty;
    }

    if (!product && leftText && !metadataLine && !isPackageFragment(leftText)) {
      pendingNameParts = [leftText];
    } else {
      pendingNameParts = [];
    }

    pendingQty = null;
  }

  return products.slice(0, 30);
}

function getCandidateTextLines(lines) {
  const dateIndex = lines.findIndex((line) =>
    /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\bdate\b/i.test(line)
  );
  const startIndex = dateIndex >= 0 ? dateIndex + 1 : 0;
  const summaryIndex = lines.findIndex(
    (line, index) => index >= startIndex && isSummaryLine(line)
  );
  const endIndex = summaryIndex >= 0 ? summaryIndex : lines.length;
  return lines.slice(startIndex, endIndex);
}

function updateProductQuantityFromUnitPrice(product, qtyCandidate, unitPrice) {
  if (!product || !Number.isFinite(unitPrice)) {
    return;
  }

  const total = Number(product.total);

  if (!Number.isFinite(total) || unitPrice <= 0 || total <= unitPrice) {
    return;
  }

  const inferredQty = Math.round(total / unitPrice);

  if (inferredQty >= 2 && Math.abs(inferredQty * unitPrice - total) < 0.06) {
    product.qty = String(inferredQty);
    return;
  }

  if (qtyCandidate && Number(qtyCandidate) >= 2 && Number(qtyCandidate) <= 99) {
    product.qty = String(qtyCandidate);
  }
}

function shouldIgnoreRawTextLine(line, skipWords) {
  const value = String(line || "").trim();

  return (
    !value ||
    skipWords.test(value) ||
    isSummaryLine(value) ||
    /^[$เนยเธเธขเธเน€เธเธ]?$/.test(value)
  );
}

function extractProductsFromTextBlocks(lines, skipWords) {
  const products = [];
  let pendingNameParts = [];
  let pendingQty = null;
  let pendingUnitPrice = null;
  let expectingQty = false;
  let lastProduct = null;
  // Tracks orphan prices that arrived before their product names (tilted receipt ordering)
  let pendingOrphanAmount = null;
  let pendingOrphanQty = null;
  // FIFO queue of products whose names were accumulated before their prices arrived
  // (OCR sometimes lists several product names in a row, then their prices afterwards)
  const deferredProducts = [];
  // Once we hit a Total/Subtotal/GST line, we're past the product list โ€” stop
  // accumulating names or orphan prices so receipt footer text doesn't become a "product".
  let pastProductList = false;

  for (const line of lines) {
    const value = String(line || "").trim();

    if (/^(?:sub\s*)?total\b|^gst\b|^cash\b|^change\b|^balance\b|^amount\s+due\b|^takeaway\s+total\b|^take[-\s]?out\s+total\b|^orki?\b/i.test(value)) {
      pastProductList = true;
    }

    if (shouldIgnoreRawTextLine(value, skipWords) || pastProductList) {
      continue;
    }

    const codeLineProduct = parseCodeLineItem(value);

    if (codeLineProduct) {
      products.push(codeLineProduct);
      lastProduct = codeLineProduct;
      pendingNameParts = [];
      pendingQty = null;
      pendingUnitPrice = null;
      pendingOrphanAmount = null;
      pendingOrphanQty = null;
      expectingQty = false;
      continue;
    }

    // Column headers (DESCRIPTION / AMOUNT / ITEM / PRICE) mark the start of the
    // product list. Clear any header noise that was accumulated before them.
    if (/^(?:description|amount|item|price)$/i.test(value)) {
      pendingNameParts = [];
      pendingQty = null;
      pendingUnitPrice = null;
      expectingQty = false;
      continue;
    }

    const amountMatches = getMoneyMatches(value);
    const lastAmountMatch = amountMatches[amountMatches.length - 1];
    const amount = lastAmountMatch ? parseMoney(lastAmountMatch[0]) : null;
    const amountOnly = amount !== null && isPriceOnlyLine(value);
    const qty = parseQuantity(value);
    const hasMetadata = hasMetadataTokens(value) || /^qty\b/i.test(value);

    if (/^qty\b/i.test(value)) {
      expectingQty = true;
    }

    if (qty && hasMetadata) {
      // OCR often reads "2 @" as "20" (the @ blends into a 0). When the line is
      // "Qty 20" with no @ visible, strip the trailing 0 โ€” same heuristic as the
      // standalone-digit case below.
      const hasAtSymbol = /@/.test(value);
      pendingQty = !hasAtSymbol && qty.length === 2 && qty.endsWith("0") ? qty.slice(0, 1) : qty;
    }

    // Structured line item: "N x $UNIT = $TOTAL" โ€” pair qty + total with the pending
    // name directly so the math expression doesn't end up inside the product name.
    const structuredMatch = value.match(
      /^(\d+(?:\.\d+)?)\s*[xX@]\s*\$?\d+(?:[.,]\d+)?\s*=\s*\$?(\d+(?:[.,]\d+)?)/
    );
    if (structuredMatch) {
      const lineQty = structuredMatch[1];
      const lineTotal = parseMoney(structuredMatch[2]);

      if (lineTotal !== null) {
        let nameParts = null;

        if (deferredProducts.length) {
          nameParts = deferredProducts.shift().nameParts;
        } else if (pendingNameParts.length) {
          nameParts = pendingNameParts;
        }

        if (nameParts) {
          const product = createProduct(joinProductParts(nameParts), lineQty, lineTotal);
          if (product) {
            products.push(product);
            lastProduct = product;
          }

          if (nameParts === pendingNameParts) {
            pendingNameParts = [];
            pendingQty = null;
            pendingUnitPrice = null;
          }
          pendingOrphanAmount = null;
          pendingOrphanQty = null;
          expectingQty = false;
          continue;
        }
      }
    }

    if (expectingQty && /^\d{1,2}$/.test(value)) {
      pendingQty = value.length === 2 && value.endsWith("0") ? value.slice(0, 1) : value;
      expectingQty = false;
      continue;
    }

    if (amount !== null && (hasMetadata || expectingQty) && lastProduct && !pendingNameParts.length) {
      updateProductQuantityFromUnitPrice(lastProduct, pendingQty, amount);
      pendingQty = null;
      pendingUnitPrice = null;
      expectingQty = false;
      continue;
    }

    if (amount !== null && hasMetadata && pendingNameParts.length) {
      pendingUnitPrice = amount;
      expectingQty = false;
      continue;
    }

    if (amountOnly) {
      // Pair price with the oldest deferred product first (its name was accumulated
      // earlier but its price hadn't arrived yet). Current pendingNameParts stays.
      if (deferredProducts.length) {
        const next = deferredProducts.shift();
        const product = createProduct(joinProductParts(next.nameParts), next.qty, amount);
        if (product) {
          products.push(product);
          lastProduct = product;
        }
        expectingQty = false;
        continue;
      }

      if (pendingNameParts.length && pendingQty && pendingUnitPrice === null) {
        pendingUnitPrice = amount;
        expectingQty = false;
        continue;
      }

      if (pendingNameParts.length) {
        // If a price arrived before these names (tilted receipt), use that price instead
        const productAmount = pendingOrphanAmount !== null ? pendingOrphanAmount : amount;
        const productQty = pendingOrphanAmount !== null ? (pendingOrphanQty ?? pendingQty) : pendingQty;
        const product = createProduct(joinProductParts(pendingNameParts), productQty, productAmount);

        if (product) {
          products.push(product);
          lastProduct = product;
        }

        pendingNameParts = [];
        pendingQty = null;
        pendingUnitPrice = null;

        if (pendingOrphanAmount !== null) {
          // Still in price-before-name mode: current amount is the next product's price
          pendingOrphanAmount = amount;
          pendingOrphanQty = null;
        }
      } else if (lastProduct && pendingQty) {
        updateProductQuantityFromUnitPrice(lastProduct, pendingQty, amount);
        pendingQty = null;
        pendingUnitPrice = null;
      } else if (lastProduct && Number(lastProduct.total) === amount) {
        // Duplicate of the just-created product's total (price+qty+total displayed
        // in separate columns, OCR returns each cell on its own line) — ignore so
        // it doesn't get treated as an orphan price for the next product.
      } else {
        // Price with no pending names: save for the name fragments that follow
        pendingOrphanAmount = amount;
        pendingOrphanQty = null;
      }

      expectingQty = false;
      continue;
    }

    if (amount !== null) {
      const leftText = value.slice(0, lastAmountMatch.index);

      if (!hasMetadata) {
        const product = createProduct(joinProductParts([...pendingNameParts, leftText]), pendingQty, amount);

        if (product) {
          products.push(product);
          lastProduct = product;
          pendingNameParts = [];
          pendingQty = null;
          pendingUnitPrice = null;
          pendingOrphanAmount = null;
          pendingOrphanQty = null;
        }
      }

      expectingQty = false;
      continue;
    }

    if (hasMetadata || value.toLowerCase() === "each") {
      continue;
    }

    const part = cleanContinuationPart(value);

    // Drop single-character OCR noise (A, T, ], *, #, /, etc.) โ€” never legitimate product text.
    if (part && part.length >= 2 && !isQuantityLine(part) && !isMetadataLine("", part)) {
      if (
        pendingNameParts.length &&
        /^(?:Golden Circle|Coca Cola|WW |Essentials |Pocky |Haribo |Ingham's)/i.test(part)
      ) {
        // Defer the previous product โ€” its price will arrive in a later line and
        // get paired via deferredProducts FIFO when amountOnly fires.
        deferredProducts.push({
          nameParts: pendingNameParts,
          qty: pendingQty,
        });
        pendingNameParts = [];
        pendingQty = null;
        pendingUnitPrice = null;
      }

      pendingNameParts.push(part);
    }
  }

  // Flush last orphan price + accumulated names (price-before-name ordering on last product)
  if (pendingOrphanAmount !== null && pendingNameParts.length > 0) {
    const product = createProduct(
      joinProductParts(pendingNameParts),
      pendingOrphanQty ?? pendingQty,
      pendingOrphanAmount
    );

    if (product) {
      products.push(product);
    }
  }

  // Any deferred products that never got their price โ’ emit with 0 so user can edit
  for (const deferred of deferredProducts) {
    const product = createProduct(joinProductParts(deferred.nameParts), deferred.qty, 0);
    if (product) {
      products.push(product);
    }
  }

  return products.slice(0, 30);
}

function productQualityScore(product) {
  const name = String(product?.name || "");
  let score = name.length;

  if (/\b(Coca|Cola|Schweppes|Pocky|Golden|Circle|Farmers|Squid|Chicken)\b/i.test(name)) {
    score += 20;
  }

  if (isPackageFragment(name) || /^\d/.test(name)) {
    score -= 40;
  }

  if (/\b[a-z0]\s+(?=[A-Z0-9])/i.test(name)) {
    score -= 35;
  }

  // Suspicious patterns from merged header noise:
  //   - timestamp inside the name (e.g. "13:08:02")
  //   - "Word:" prefix like "Host:", "Date:", "Cashier:"
  //   - very long name (typically header + product merged)
  if (/\d{1,2}:\d{2}/.test(name)) {
    score -= 60;
  }
  if (/^[A-Za-z]\w*:\s/.test(name)) {
    score -= 60;
  }
  if (name.length > 50) {
    score -= 60;
  }

  return score;
}

function noisyContinuationCount(products) {
  return products.filter((product) => /\b[a-z0]\s+(?=[A-Z0-9])/i.test(product.name)).length;
}

function chooseBestParsedProducts(rowProducts, textProducts) {
  if (!textProducts.length) {
    return rowProducts;
  }

  if (!rowProducts.length) {
    return textProducts;
  }

  const rowFragmentCount = rowProducts.filter((product) => isPackageFragment(product.name)).length;
  const textFragmentCount = textProducts.filter((product) => isPackageFragment(product.name)).length;

  if (rowFragmentCount > textFragmentCount) {
    return textProducts;
  }

  if (rowProducts.length > textProducts.length && rowFragmentCount <= textFragmentCount) {
    return rowProducts;
  }

  if (noisyContinuationCount(rowProducts) > noisyContinuationCount(textProducts)) {
    return textProducts;
  }

  if (textProducts.length < rowProducts.length && rowFragmentCount <= textFragmentCount) {
    return rowProducts;
  }

  const rowScore = rowProducts.reduce((sum, product) => sum + productQualityScore(product), 0);
  const textScore = textProducts.reduce((sum, product) => sum + productQualityScore(product), 0);

  if (textProducts.length >= rowProducts.length * 0.75 && textScore >= rowScore) {
    return textProducts;
  }

  return rowProducts;
}

function extractProducts(lines, skipWords) {
  const products = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sameLineMatch = line.match(/^(.+?)\s+([$โฌยฃเธฟ]?\s*\d[\d,.]*[.,]\d{2})$/);

    if (sameLineMatch && !skipWords.test(line)) {
      const name = cleanProductName(sameLineMatch[1]);
      const amount = parseMoney(sameLineMatch[2]);

      if (name.length >= 2 && amount !== null) {
        products.push({ name, total: amount });
      }

      continue;
    }

    const nextLine = lines[index + 1];

    if (
      nextLine &&
      isAmountOnly(nextLine) &&
      !isAmountOnly(line) &&
      !skipWords.test(line)
    ) {
      const name = cleanProductName(line);
      const amount = parseMoney(nextLine);

      if (name.length >= 2 && amount !== null) {
        products.push({ name, total: amount });
      }

      index += 1;
    }
  }

  return products.slice(0, 30);
}

function getLineItemCandidates(lines) {
  const totalIndex = lines.findIndex((line) =>
    /^total\b|^total\s*to\s*pay\b/i.test(line)
  );
  const dateIndex = lines.findIndex((line) =>
    /\bdate\b|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/i.test(line)
  );
  const tableIndex = lines.findIndex((line) => /\btable\b|\bcovers?\b/i.test(line));
  const startIndex = tableIndex >= 0 ? tableIndex + 1 : dateIndex >= 0 ? dateIndex + 1 : 0;
  const endIndex = totalIndex >= 0 ? totalIndex : lines.length;

  return lines.slice(startIndex, endIndex);
}

// Use the receipt total as a checksum to repair common OCR price errors.
//   1) `.99` misread as `.00` on faded thermal receipts (Chemist Warehouse style).
//   2) Currency symbol (e.g. ฿ Baht) misread as a leading "8" digit, inflating the
//      number by ~8000 (e.g. "฿170.00" → "8170.00").
function reconcileSumAgainstTotal(products, total) {
  if (total === null || total === undefined || !Number.isFinite(Number(total))) {
    return products;
  }
  if (!Array.isArray(products) || products.length === 0) {
    return products;
  }

  const cents = (n) => Math.round(Number(n) * 100);
  const targetCents = cents(total);

  // Pass 1: when a single product is suspiciously larger than the receipt total,
  // try two common OCR repairs and commit whichever makes the sum land on total:
  //   (a) strip a misread currency-symbol leading digit ("฿170" read as "8170")
  //   (b) divide by 100 ("$21.99" read as "$2199" with the decimal point dropped)
  const oversized = products
    .map((p, idx) => ({ idx, cents: cents(p.total || 0) }))
    .filter((c) => c.cents > targetCents && String(Math.abs(c.cents)).length >= 5);
  if (oversized.length === 1) {
    const { idx, cents: bigCents } = oversized[0];
    const sign = Math.sign(bigCents) || 1;
    const text = String(Math.round(Math.abs(bigCents)));

    const tryFix = (newTotal) => {
      const candidate = products.map((p, i) => (i === idx ? { ...p, total: newTotal } : p));
      const newSum = candidate.reduce((acc, p) => acc + cents(p.total || 0), 0);
      return Math.abs(newSum - targetCents) < 1 ? candidate : null;
    };

    let fixed = null;
    // (a) strip leading digit
    if (text.length >= 4) {
      fixed = tryFix((Number(text.slice(1)) * sign) / 100);
    }
    // (b) restore missing decimal point — e.g. "2199" → 21.99
    if (!fixed) {
      fixed = tryFix((Number(text) * sign) / 10000);
    }
    if (fixed) products = fixed;
  }

  const sumCents = products.reduce((acc, p) => acc + cents(p.total || 0), 0);
  const diffCents = targetCents - sumCents;

  if (Math.abs(diffCents) < 1) return products;

  // Pass 2: upgrade .00 → .99 endings if doing so for every .00-candidate makes
  // the sum match the total exactly. Skip ambiguous partial cases.
  const candidates = products
    .map((p, idx) => ({ idx, cents: cents(p.total || 0) }))
    .filter((c) => c.cents % 100 === 0);

  if (candidates.length > 0 && diffCents === candidates.length * 99) {
    return products.map((p, idx) => {
      const isCandidate = candidates.some((c) => c.idx === idx);
      return isCandidate ? { ...p, total: (cents(p.total) + 99) / 100 } : p;
    });
  }

  // Pass 3: if exactly one product has price = 0 and the diff is positive, that
  // product is the OCR-mangled item — assign the missing amount to it.
  const zeroPriced = products
    .map((p, idx) => ({ idx, cents: cents(p.total || 0) }))
    .filter((c) => c.cents === 0);
  if (zeroPriced.length === 1 && diffCents > 0) {
    const { idx } = zeroPriced[0];
    return products.map((p, i) => (i === idx ? { ...p, total: diffCents / 100 } : p));
  }

  return products;
}

function parseOcrExpense(rawText, entries = []) {
  const text = normalizeOcrText(rawText);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const skipWords = /address|tel|date|receipt|table|covers?|server|total|subtotal|sub\s*total|rounding|tax|vat|gst|change|cash|payment|paid|balance|thank|service|phone|email|reg|master|member|loyalty|\bwatsons?\b|\bwoolworths\b|qr-*\s*code|vat\s+no|^pos\s|tax\s*id|invoice\s*number|opening\s+balance|loyalty|^supervisor|duplicate|^statement$|^why\s+pay/i;
  // Try the raw lines first (each OCR entry on its own line) so "Total:" gets
  // matched cleanly without bleed from adjacent "GST Included In Total:" labels.
  // Fall back to row-joined text for receipts that split labels and amounts
  // across separate OCR lines (e.g. "Takeaway Total" + "78.00").
  const rowJoinedLines = getOcrRows(entries).map((row) => row.text).filter(Boolean);
  const total = findTotal(lines) ?? (rowJoinedLines.length ? findTotal(rowJoinedLines) : null);
  const rowProducts = extractProductsFromRows(getCandidateRows(lines, entries), skipWords);
  const textProducts = extractProductsFromTextBlocks(getCandidateTextLines(lines), skipWords);
  let products = chooseBestParsedProducts(rowProducts, textProducts);

  if (!products.length) {
    products = extractProducts(getLineItemCandidates(lines), skipWords);
  }

  if (!products.length) {
    products = extractProducts(lines, skipWords);
  }
  // Reconcile BEFORE the receipt-total filter so Baht-misread inflated prices
  // get corrected before normalize would discard them as "larger than total".
  products = reconcileSumAgainstTotal(products, total);
  products = normalizeParsedProducts(products, total);

  return expenseSchema.parse({
    products,
    total,
    status: "Paid",
    dueDate: null,
    paymentType: "Cash",
  });
}

async function appendToSheet(expense) {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return { skipped: true, reason: "Google Sheets is not configured." };
  }

  const spreadsheetId = requiredEnv("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = EXPENSE_SHEET_NAME;
  const sheets = getSheetsClient();

  await ensureSheetHeader(sheets, spreadsheetId, sheetName);
  const rows = buildSheetRows(expense);

  const appendResult = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: rows,
    },
  });

  await formatSubmittedRows(
    sheets,
    spreadsheetId,
    sheetName,
    rows,
    appendResult.data.updates?.updatedRange
  );

  return { skipped: false, rowsAdded: rows.length };
}

async function extractExpenseData(file) {
  const ai = new GoogleGenAI({ apiKey: requiredEnv("GEMINI_API_KEY") });
  const imageBase64 = file.buffer.toString("base64");

  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        systemInstruction:
          "Extract expense data into JSON for a Google Sheet. Use null when a field is not visible. Only use allowed enum values exactly.",
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Read this receipt or invoice image and extract only these fields: products as separate purchasable line items with name and line total, overall total, payment status as Paid or Unpaid, due date only when status is Unpaid in DD/MM/YYYY format, and payment type as Cash, Credit Card, or Online Banking. Do not include discount, coupon, promotion, voucher, markdown, rounding, tax, subtotal, total, cash, change, or payment rows as products. If a discount applies to an item, keep the product price as printed for the product line and ignore the separate discount line. If status or payment type is not visible, return null. If products repeat, keep each occurrence as a separate product row.",
              },
              {
                inlineData: {
                  mimeType: file.mimetype,
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: expenseResponseSchema,
        },
      });

      const parsed = JSON.parse(response.text);
      return removeDiscountProducts(expenseSchema.parse(parsed));
    } catch (error) {
      const shouldRetry =
        attempt < GEMINI_MAX_RETRIES && isRetryableGeminiError(error);

      if (!shouldRetry) {
        throw error;
      }

      await wait(1000 * attempt);
    }
  }
}

async function analyzeReceiptImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No receipt image uploaded." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({
        error:
          "GEMINI_API_KEY is missing. Create a .env file in the project root and add your secret key.",
      });
    }

    const parsedExpense = await extractExpenseData(req.file);

    return res.json({
      success: true,
      engine: "gemini",
      model: GEMINI_MODEL,
      message: "Receipt analyzed with Gemini. Review the preview before submitting.",
      receipt: parsedExpense,
      sheetPreview: buildSheetPreview(parsedExpense),
    });
  } catch (error) {
    const { httpStatus, message } = getClientError(error);
    return res.status(httpStatus).json({ error: message });
  }
}

app.use("/assets", express.static(path.join(projectRoot, "public")));
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("html").send(renderAccessPage());
});

app.post("/api/login", async (req, res) => {
  try {
    const user = await findUserByPass(req.body?.pass);

    if (!user) {
      return res.status(401).json({ error: "Invalid access code." });
    }

    setAuthCookie(res, user);
    return res.json({ success: true, user });
  } catch (error) {
    const { httpStatus, message } = getClientError(error);
    return res.status(httpStatus).json({ error: message });
  }
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME);
  return res.json({ success: true });
});

app.get("/upload", requireAuth, (req, res) => {
  res.type("html").send(renderReceiptPage(req.user));
});

app.get("/api/health", (_req, res) => {
  res.json(getHealthStatus());
});

app.post("/api/receipts/analyze", requireAuth, uploadReceipt, analyzeReceiptImage);
app.post("/api/receipts/ocr", requireAuth, uploadReceipt, analyzeReceiptImage);

app.post("/api/receipts/submit", requireAuth, async (req, res) => {
  try {
    const parsedExpense = removeDiscountProducts(expenseSchema.parse(req.body?.receipt));
    const sheetResult = await appendToSheet(parsedExpense);

    return res.json({
      success: true,
      message: sheetResult.skipped
        ? "Google Sheets was skipped because it is not configured yet."
        : "Receipt saved to Google Sheets.",
      sheet: sheetResult,
    });
  } catch (error) {
    const { httpStatus, message } = getClientError(error);
    return res.status(httpStatus).json({ error: message });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint was not found." });
});

app.use((error, req, res, next) => {
  if (!req.originalUrl.startsWith("/api/")) {
    return next(error);
  }

  const { httpStatus, message } = getClientError(error);
  return res.status(httpStatus).json({ error: message });
});

if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Receipt app listening on http://localhost:${PORT}`);
  });
}

export default app;
export { parseOcrExpense, buildSheetPreview };

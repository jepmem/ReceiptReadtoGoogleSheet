# Receipt Prototype

Express app for uploading or photographing receipt images, extracting receipt data with Gemini, and appending the result to Google Sheets.

## Project structure

- `src/server.js` - Express server and API routes
- `src/views/accessPage.js` - access code page
- `src/views/receiptPage.js` - receipt upload page
- `public/` - frontend assets such as CSS and browser JavaScript

## Setup

1. Copy `.env.example` to `.env`
2. Fill in these values:
   - `RECEIPT_UPLOAD_MAX_MB` (optional, defaults to `25`)
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` (optional, defaults to `gemini-2.5-flash-lite`)
   - `GEMINI_MAX_RETRIES` (optional, defaults to `3`)
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_WORKSHEET_NAME` (defaults to `EXPENSES`)
   - `GOOGLE_SHEETS_ID_WORKSHEET_NAME` (optional, defaults to `ID`)
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
3. Share your Google Sheet with the service account email as an editor
4. Add an `ID` tab with `ID`, `NAME`, and `PASS` columns. The home page checks the `PASS` column before allowing access to the upload page.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`

## Gemini setup

Receipt analysis uses Gemini through `@google/genai`. The default model is `gemini-2.5-flash-lite`, which is the cheapest Gemini 2.5 Flash option while still supporting image input and structured JSON output.

Create a Gemini API key in Google AI Studio, add it to `.env` as `GEMINI_API_KEY`, then restart the server.

## What gets extracted

- Product names as separate rows
- Quantity when visible
- Product line total price
- Status as `Paid` or `Unpaid`
- Due Date when the receipt is unpaid
- Payment_Type as `Cash`, `Credit Card`, or `Online Banking`

The `EXPENSES` tab uses these columns:

- `Date`
- `Product`
- `Qty`
- `Price`
- `Status`
- `Due Date`
- `Payment_Type`

Each submitted receipt also writes a summary label `Total` in column H and the receipt total in column I on the last product row.

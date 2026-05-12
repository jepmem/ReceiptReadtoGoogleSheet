export function renderAccessPage() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Receipt to Sheet</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%BE%3C/text%3E%3C/svg%3E" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/assets/styles.css" />
  </head>
  <body class="landing-body">
    <main class="landing-shell">
      <section class="landing-panel">
        <div class="landing-copy">
          <p class="eyebrow">Receipt to Sheet</p>
          <h1>Upload a receipt and send structured data to Google Sheets</h1>
          <p class="lead">
            Enter your access code to open the receipt scanner. Codes are checked against the ID tab in the connected Google Sheet.
          </p>
        </div>

        <form class="access-form" id="accessForm" autocomplete="off">
          <label for="accessCode">Access code</label>
          <div class="access-row">
            <input
              id="accessCode"
              name="pass"
              type="password"
              inputmode="text"
              placeholder="Enter code"
              required
            />
            <button class="primary-button" id="accessButton" type="submit">
              Continue
            </button>
          </div>
          <p class="form-message" id="accessMessage" aria-live="polite"></p>
        </form>
      </section>
    </main>
    <script type="module" src="/assets/home.js"></script>
  </body>
</html>`;
}

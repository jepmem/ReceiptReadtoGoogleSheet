const uploadModeButton = document.getElementById("uploadModeButton");
const cameraModeButton = document.getElementById("cameraModeButton");
const filePickerPanel = document.getElementById("filePickerPanel");
const cameraPanel = document.getElementById("cameraPanel");
const receiptFile = document.getElementById("receiptFile");
const previewPanel = document.getElementById("previewPanel");
const imagePreviewFrame = document.getElementById("imagePreviewFrame");
const imagePreview = document.getElementById("imagePreview");
const previewName = document.getElementById("previewName");
const zoomOutButton = document.getElementById("zoomOutButton");
const zoomResetButton = document.getElementById("zoomResetButton");
const zoomInButton = document.getElementById("zoomInButton");
const zoomValue = document.getElementById("zoomValue");
const analyzeButton = document.getElementById("analyzeButton");
const confirmEditButton = document.getElementById("confirmEditButton");
const submitButton = document.getElementById("submitButton");
const statusText = document.getElementById("statusText");
const resultOutput = document.getElementById("resultOutput");
const startCameraButton = document.getElementById("startCameraButton");
const captureButton = document.getElementById("captureButton");
const cameraPreview = document.getElementById("cameraPreview");
const captureCanvas = document.getElementById("captureCanvas");

let currentFile = null;
let cameraStream = null;
let analyzedReceipt = null;
let draftReceipt = null;
let isEditingReceipt = false;
let previewZoom = 1;
let isDraggingPreview = false;
let previewDragStartX = 0;
let previewDragStartY = 0;
let previewDragStartScrollLeft = 0;
let previewDragStartScrollTop = 0;
let healthState = {
  geminiConfigured: false,
  geminiModel: "",
  googleSheetsConfigured: false,
  loaded: false,
};

const MIN_PREVIEW_ZOOM = 0.5;
const MAX_PREVIEW_ZOOM = 3;
const PREVIEW_ZOOM_STEP = 0.25;

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();

  if (!text) {
    if (response.ok) {
      return {};
    }

    throw createHttpError(fallbackMessage, response.status);
  }

  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html") || text.trim().startsWith("<");
    const message = isHtml
      ? "The Gemini API returned an HTML page instead of JSON. Restart the server, then sign in again if needed."
      : fallbackMessage;

    throw createHttpError(message, response.status);
  }
}

function refreshReadyState() {
  if (!healthState.loaded) {
    analyzeButton.disabled = true;
    statusText.textContent = "Checking configuration";
    return;
  }

  if (!healthState.geminiConfigured) {
    analyzeButton.disabled = true;
    statusText.textContent = "Gemini API key is missing";
    return;
  }

  analyzeButton.disabled = !currentFile;

  if (!currentFile) {
    statusText.textContent = healthState.googleSheetsConfigured
      ? "Ready"
      : "Ready to analyze. Google Sheets is not configured.";
    return;
  }

  statusText.textContent = healthState.googleSheetsConfigured
    ? "Ready to analyze"
    : "Ready to analyze. Results will not be saved to Google Sheets.";
}

async function loadHealthStatus() {
  try {
    const response = await fetch("/api/health");
    const data = await readJsonResponse(response, "Unable to check system status.");

    healthState = {
      geminiConfigured: Boolean(data.geminiConfigured),
      geminiModel: data.geminiModel || "",
      googleSheetsConfigured: Boolean(data.googleSheetsConfigured),
      loaded: true,
    };

    if (!healthState.geminiConfigured) {
      resultOutput.textContent =
        "GEMINI_API_KEY is missing in .env, so receipt analysis is disabled.";
    } else if (!healthState.googleSheetsConfigured) {
      resultOutput.textContent =
        "Gemini is ready. Google Sheets settings are missing in .env, so results will stay on this page.";
    } else {
      resultOutput.textContent = "No receipt has been analyzed yet.";
    }

    refreshReadyState();
  } catch (error) {
    healthState.loaded = true;
    analyzeButton.disabled = true;
    statusText.textContent = "Unable to check system status";
    resultOutput.textContent =
      error instanceof Error ? error.message : "Unknown error";
  }
}

function setMode(mode) {
  const isUpload = mode === "upload";
  uploadModeButton.classList.toggle("active", isUpload);
  cameraModeButton.classList.toggle("active", !isUpload);
  filePickerPanel.classList.toggle("hidden", !isUpload);
  cameraPanel.classList.toggle("hidden", isUpload);
}

function updatePreviewZoom() {
  imagePreview.style.setProperty("--preview-zoom", previewZoom);
  zoomValue.textContent = `${Math.round(previewZoom * 100)}%`;
  zoomOutButton.disabled = previewZoom <= MIN_PREVIEW_ZOOM;
  zoomInButton.disabled = previewZoom >= MAX_PREVIEW_ZOOM;
}

function setPreviewZoom(nextZoom) {
  const previousZoom = previewZoom;
  previewZoom = Math.min(
    MAX_PREVIEW_ZOOM,
    Math.max(MIN_PREVIEW_ZOOM, Number(nextZoom.toFixed(2)))
  );
  updatePreviewZoom();

  if (!imagePreviewFrame || previousZoom === previewZoom) {
    return;
  }

  const ratio = previewZoom / previousZoom;
  imagePreviewFrame.scrollLeft = (imagePreviewFrame.scrollLeft + imagePreviewFrame.clientWidth / 2) * ratio - imagePreviewFrame.clientWidth / 2;
  imagePreviewFrame.scrollTop = (imagePreviewFrame.scrollTop + imagePreviewFrame.clientHeight / 2) * ratio - imagePreviewFrame.clientHeight / 2;
}

function resetPreviewZoom() {
  previewZoom = 1;
  updatePreviewZoom();
  imagePreviewFrame.scrollTo({ left: 0, top: 0, behavior: "smooth" });
}

function startPreviewDrag(event) {
  if (event.button !== 0 || previewZoom <= 1) {
    return;
  }

  isDraggingPreview = true;
  previewDragStartX = event.clientX;
  previewDragStartY = event.clientY;
  previewDragStartScrollLeft = imagePreviewFrame.scrollLeft;
  previewDragStartScrollTop = imagePreviewFrame.scrollTop;
  imagePreviewFrame.classList.add("dragging");
  imagePreviewFrame.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function movePreviewDrag(event) {
  if (!isDraggingPreview) {
    return;
  }

  imagePreviewFrame.scrollLeft =
    previewDragStartScrollLeft - (event.clientX - previewDragStartX);
  imagePreviewFrame.scrollTop =
    previewDragStartScrollTop - (event.clientY - previewDragStartY);
}

function stopPreviewDrag(event) {
  if (!isDraggingPreview) {
    return;
  }

  isDraggingPreview = false;
  imagePreviewFrame.classList.remove("dragging");

  if (imagePreviewFrame.hasPointerCapture(event.pointerId)) {
    imagePreviewFrame.releasePointerCapture(event.pointerId);
  }
}

function renderPreview(file) {
  currentFile = file;
  analyzedReceipt = null;
  draftReceipt = null;
  previewName.textContent = file.name;
  imagePreview.src = URL.createObjectURL(file);
  resetPreviewZoom();
  previewPanel.classList.remove("hidden");
  confirmEditButton.classList.add("hidden");
  submitButton.classList.add("hidden");
  refreshReadyState();
}

function setBusyState(isBusy) {
  analyzeButton.disabled = isBusy || !currentFile;
  analyzeButton.textContent = isBusy
    ? "Reading receipt..."
    : "Analyze receipt";
}

function setSubmitBusyState(isBusy) {
  submitButton.disabled = isBusy || !analyzedReceipt;
  submitButton.textContent = isBusy
    ? "Submitting..."
    : "Submit to Google Sheets";
}

function setConfirmVisible(isVisible) {
  confirmEditButton.classList.toggle("hidden", !isVisible);
  confirmEditButton.disabled = !isVisible;
}

function setEditButtonMode(mode) {
  isEditingReceipt = mode === "confirm";
  confirmEditButton.textContent = isEditingReceipt ? "Confirm edits" : "Edit";
  setConfirmVisible(Boolean(analyzedReceipt || draftReceipt));
}

function formatPreviewValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function escapeHtml(value) {
  return formatPreviewValue(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSheetPreview(sheetPreview) {
  const headers = sheetPreview.headers || [];
  const rows = sheetPreview.rows || [];
  const total =
    sheetPreview.total !== null && sheetPreview.total !== undefined
      ? `<div class="preview-total"><span>Total</span><strong>${escapeHtml(
          sheetPreview.total
        )}</strong></div>`
      : "";
  const headerCells = headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join("");
  const bodyRows = rows
    .map(
      (row) => `
        <tr>
          ${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}
        </tr>
      `
    )
    .join("");

  resultOutput.innerHTML = `
    <div class="preview-scroll">
      <table class="preview-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    ${total}
  `;
}

function getReceiptTotal(receipt) {
  if (receipt.total !== null && receipt.total !== undefined) {
    return receipt.total;
  }

  const total = (receipt.products || []).reduce((sum, product) => {
    const price = Number(product.total);
    return Number.isFinite(price) ? sum + price : sum;
  }, 0);

  return Number(total.toFixed(2));
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

function renderEditableReceipt(receipt) {
  draftReceipt = {
    products: (receipt.products || []).map((product) => ({
      ...product,
      qty: product.qty || "1",
      status: product.status ?? receipt.status ?? "Paid",
      dueDate: product.dueDate ?? receipt.dueDate ?? null,
      paymentType: product.paymentType ?? receipt.paymentType ?? "Cash",
    })),
    total: receipt.total,
    status: receipt.status || "Paid",
    dueDate: receipt.dueDate || null,
    paymentType: receipt.paymentType || "Cash",
  };
  analyzedReceipt = null;
  setEditButtonMode("confirm");
  submitButton.classList.add("hidden");
  statusText.textContent = "Edit and confirm before submitting";

  const rows = draftReceipt.products.length
    ? draftReceipt.products
    : [{ name: "", qty: "1", total: draftReceipt.total }];
  const bodyRows = rows
    .map(
      (product, index) => `
        <tr data-row-index="${index}">
          <td>
            <input class="table-input product-input" data-field="name" value="${escapeHtml(
              product.name
            )}" />
          </td>
          <td>
            <input class="table-input qty-input" data-field="qty" value="${escapeHtml(
              product.qty || ""
            )}" />
          </td>
          <td>
            <input class="table-input price-input" data-field="total" inputmode="decimal" value="${escapeHtml(
              product.total ?? ""
            )}" />
          </td>
          <td>
            <select class="table-input status-input" data-field="status">
              <option value="Paid" ${product.status === "Paid" ? "selected" : ""}>Paid</option>
              <option value="Unpaid" ${product.status === "Unpaid" ? "selected" : ""}>Unpaid</option>
            </select>
          </td>
          <td>
            <input class="table-input due-date-input" data-field="dueDate" placeholder="DD/MM/YYYY" value="${escapeHtml(
              product.dueDate || ""
            )}" />
          </td>
          <td>
            <select class="table-input payment-input" data-field="paymentType">
              <option value="" ${!product.paymentType ? "selected" : ""}>-</option>
              <option value="Cash" ${product.paymentType === "Cash" ? "selected" : ""}>Cash</option>
              <option value="Credit Card" ${product.paymentType === "Credit Card" ? "selected" : ""}>Credit Card</option>
              <option value="Online Banking" ${product.paymentType === "Online Banking" ? "selected" : ""}>Online Banking</option>
            </select>
          </td>
          <td>
            <button class="delete-row-button" data-action="delete-row" type="button" title="Delete row" aria-label="Delete row">
              Delete
            </button>
          </td>
        </tr>
      `
    )
    .join("");

  resultOutput.innerHTML = `
    <div class="preview-scroll">
      <table class="preview-table editable-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Status</th>
            <th>Due Date</th>
            <th>Payment_Type</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <div class="preview-total"><span>Total</span><strong id="editableTotal">${escapeHtml(
      getReceiptTotal(draftReceipt)
    )}</strong></div>
  `;

  resultOutput
    .querySelectorAll(".table-input")
    .forEach((input) => input.addEventListener("input", handleDraftInput));
  resultOutput
    .querySelectorAll("select.table-input")
    .forEach((input) => input.addEventListener("change", handleDraftInput));
  resultOutput
    .querySelectorAll("[data-action='delete-row']")
    .forEach((button) => button.addEventListener("click", handleDeleteDraftRow));
}

function refreshDraftTotal() {
  draftReceipt.total = getReceiptTotal({
    ...draftReceipt,
    total: null,
  });
  const totalElement = document.getElementById("editableTotal");

  if (totalElement) {
    totalElement.textContent = formatPreviewValue(draftReceipt.total);
  }
}

function handleDraftInput(event) {
  if (!draftReceipt) {
    return;
  }

  const row = event.target.closest("tr");
  const index = Number(row?.dataset.rowIndex);
  const field = event.target.dataset.field;

  if (Number.isInteger(index) && draftReceipt.products[index]) {
    draftReceipt.products[index][field] =
      field === "total" ? parseMoney(event.target.value) : event.target.value;
  }

  refreshDraftTotal();
  analyzedReceipt = null;
  submitButton.classList.add("hidden");
  setEditButtonMode("confirm");
  statusText.textContent = "Confirm edits before submitting";
}

function handleDeleteDraftRow(event) {
  if (!draftReceipt) {
    return;
  }

  const row = event.target.closest("tr");
  const index = Number(row?.dataset.rowIndex);

  if (!Number.isInteger(index)) {
    return;
  }

  draftReceipt.products.splice(index, 1);
  draftReceipt.total = null;
  renderEditableReceipt(draftReceipt);
  statusText.textContent = "Row deleted. Confirm edits before submitting";
}

function enterEditMode() {
  if (isEditingReceipt) {
    confirmEdits();
    return;
  }

  if (!analyzedReceipt) {
    statusText.textContent = "Analyze a receipt first";
    return;
  }

  renderEditableReceipt(analyzedReceipt);
}

function confirmEdits() {
  if (!draftReceipt) {
    statusText.textContent = "Analyze a receipt first";
    return;
  }

  analyzedReceipt = {
    products: draftReceipt.products
      .map((product) => ({
        name: String(product.name || "").trim(),
        qty: String(product.qty || "1").trim() || "1",
        total: product.total ?? null,
        status: product.status || "Paid",
        dueDate: product.status === "Unpaid" ? product.dueDate || null : null,
        paymentType: product.paymentType || null,
      }))
      .filter((product) => !isDiscountProduct(product))
      .filter((product) => product.name || product.total !== null),
    total: draftReceipt.total,
    status: null,
    dueDate: null,
    paymentType: "Cash",
  };
  draftReceipt = null;
  setEditButtonMode("edit");
  statusText.textContent = "Edits confirmed";
  renderSheetPreview(buildLocalSheetPreview(analyzedReceipt));
  submitButton.classList.toggle("hidden", !healthState.googleSheetsConfigured);
}


function parseMoney(value) {
  const matches = String(value || "").match(/-?\d[\d,]*(?:\.\d{1,2})?/g);

  if (!matches?.length) {
    return null;
  }

  const amount = Number(matches[matches.length - 1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}


function buildLocalSheetPreview(receipt) {
  const visibleProducts = (receipt.products || []).filter(
    (product) => !isDiscountProduct(product)
  );
  const products = visibleProducts.length
    ? visibleProducts
    : [{ name: "", qty: "1", total: receipt.total }];
  const total =
    receipt.total ??
    Number(products.reduce((sum, product) => {
      const price = Number(product.total);
      return Number.isFinite(price) ? sum + price : sum;
    }, 0).toFixed(2));
  const rows = products.map((product) => [
    "Created when submitted",
    product.name,
    product.qty || "1",
    product.total ?? receipt.total ?? "",
    product.status ?? receipt.status ?? "",
    (product.status ?? receipt.status) === "Unpaid"
      ? product.dueDate ?? receipt.dueDate ?? ""
      : "",
    product.paymentType ?? receipt.paymentType ?? "",
  ]);

  return {
    headers: ["Date", "Product", "Qty", "Price", "Status", "Due Date", "Payment_Type"],
    rows,
    total,
  };
}

function renderAnalysisResult(sheetPreview) {
  renderSheetPreview(sheetPreview);
}

async function startCamera() {
  if (cameraStream) {
    return;
  }

  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });

  cameraPreview.srcObject = cameraStream;
}

function stopCamera() {
  if (!cameraStream) {
    return;
  }

  for (const track of cameraStream.getTracks()) {
    track.stop();
  }

  cameraPreview.srcObject = null;
  cameraStream = null;
}

function captureImage() {
  if (!cameraPreview.videoWidth || !cameraPreview.videoHeight) {
    statusText.textContent = "Camera is not ready yet";
    return;
  }

  captureCanvas.width = cameraPreview.videoWidth;
  captureCanvas.height = cameraPreview.videoHeight;
  const ctx = captureCanvas.getContext("2d");

  if (!ctx) {
    statusText.textContent = "Unable to prepare the camera image";
    return;
  }

  ctx.drawImage(cameraPreview, 0, 0);

  captureCanvas.toBlob((blob) => {
    if (!blob) {
      statusText.textContent = "Unable to create the image file";
      return;
    }

    const file = new File([blob], `receipt-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });

    renderPreview(file);
    stopCamera();
  }, "image/jpeg", 0.92);
}

async function analyzeReceipt() {
  if (!currentFile) {
    statusText.textContent = "Choose an image first";
    return;
  }

  setBusyState(true);
  statusText.textContent = "Preparing Gemini";
  resultOutput.textContent = "Analyzing the receipt image...";
  submitButton.classList.add("hidden");
  setConfirmVisible(false);
  analyzedReceipt = null;
  draftReceipt = null;
  isEditingReceipt = false;

  try {
    const formData = new FormData();
    formData.append("receipt", currentFile);
    statusText.textContent = "Reading with Gemini";

    const response = await fetch("/api/receipts/analyze", {
      method: "POST",
      body: formData,
    });
    const data = await readJsonResponse(response, "Gemini is not available.");

    if (!response.ok) {
      throw createHttpError(data.error || "Gemini is not available.", response.status);
    }

    analyzedReceipt = data.receipt;
    statusText.textContent = "Review or edit before submitting";
    renderAnalysisResult(data.sheetPreview || buildLocalSheetPreview(data.receipt));
    setEditButtonMode("edit");
    submitButton.classList.toggle("hidden", !healthState.googleSheetsConfigured);
  } catch (error) {
    if (error?.status === 401) {
      statusText.textContent = "Sign-in expired";
      resultOutput.innerHTML = `<div class="preview-error">${escapeHtml(
        error.message
      )}</div>`;
      return;
    }

    statusText.textContent = "Gemini failed";
    resultOutput.innerHTML = `<div class="preview-error">${
      error instanceof Error ? escapeHtml(error.message) : "Gemini failed."
    }</div>`;
  } finally {
    setBusyState(false);
    if (statusText.textContent !== "Sign-in expired") {
      refreshReadyState();
    }
  }
}

async function submitReceipt() {
  if (!analyzedReceipt) {
    statusText.textContent = "Analyze a receipt first";
    return;
  }

  setSubmitBusyState(true);
  statusText.textContent = "Submitting to Google Sheets";

  try {
    const response = await fetch("/api/receipts/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt: analyzedReceipt }),
    });
    const data = await readJsonResponse(response, "Unable to submit the receipt.");

    if (!response.ok) {
      throw createHttpError(data.error || "Unable to submit the receipt.", response.status);
    }

    statusText.textContent = data.sheet?.skipped
      ? "Sheet save was skipped."
      : "Saved to Google Sheets.";
    submitButton.classList.add("hidden");
  } catch (error) {
    statusText.textContent = "Submit failed";
    resultOutput.insertAdjacentHTML(
      "afterbegin",
      `<div class="preview-error">${
        error instanceof Error ? escapeHtml(error.message) : "Unknown error"
      }</div>`
    );
  } finally {
    setSubmitBusyState(false);
  }
}

uploadModeButton.addEventListener("click", () => setMode("upload"));
cameraModeButton.addEventListener("click", () => setMode("camera"));

receiptFile.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) {
    renderPreview(file);
  }
});

startCameraButton.addEventListener("click", async () => {
  try {
    await startCamera();
    statusText.textContent = "Camera is ready";
  } catch (error) {
    statusText.textContent = "Unable to open the camera";
    resultOutput.textContent =
      error instanceof Error ? error.message : "Unknown error";
  }
});

captureButton.addEventListener("click", captureImage);
zoomOutButton.addEventListener("click", () =>
  setPreviewZoom(previewZoom - PREVIEW_ZOOM_STEP)
);
zoomResetButton.addEventListener("click", resetPreviewZoom);
zoomInButton.addEventListener("click", () =>
  setPreviewZoom(previewZoom + PREVIEW_ZOOM_STEP)
);
imagePreviewFrame.addEventListener("pointerdown", startPreviewDrag);
imagePreviewFrame.addEventListener("pointermove", movePreviewDrag);
imagePreviewFrame.addEventListener("pointerup", stopPreviewDrag);
imagePreviewFrame.addEventListener("pointercancel", stopPreviewDrag);
analyzeButton.addEventListener("click", analyzeReceipt);
confirmEditButton.addEventListener("click", enterEditMode);
submitButton.addEventListener("click", submitReceipt);

window.addEventListener("beforeunload", stopCamera);
updatePreviewZoom();
loadHealthStatus();

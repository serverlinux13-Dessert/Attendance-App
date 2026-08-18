const scanModeSelect = document.getElementById("scanMode");
const qrModeSection = document.getElementById("qrModeSection");
const otpModeSection = document.getElementById("otpModeSection");
const sessionInput = document.getElementById("session");
const otpEmployeeCodeInput = document.getElementById("otpEmployeeCode");
const otpCodeInput = document.getElementById("otpCode");
const scanQrBtn = document.getElementById("scanQrBtn");
const scanOtpBtn = document.getElementById("scanOtpBtn");
const statusEl = document.getElementById("status");
const previewVideo = document.getElementById("preview");
const captureCanvas = document.getElementById("captureCanvas");
const startCamBtn = document.getElementById("startCamBtn");
const stopCamBtn = document.getElementById("stopCamBtn");

let stream = null;
let scanning = false;
let barcodeDetector = null;

if ("BarcodeDetector" in window) {
  barcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
}

function currentMode() {
  return scanModeSelect ? scanModeSelect.value : "qr";
}

function setStatus(message) {
  statusEl.textContent = message;
}

function parseSessionId(rawValue) {
  if (!rawValue) return "";
  try {
    const obj = JSON.parse(rawValue);
    if (obj && typeof obj.session_token === "string") {
      return obj.session_token;
    }
    if (obj && typeof obj.session_id === "string") {
      return obj.session_id;
    }
  } catch (_error) {
    // Non-JSON values are treated as direct session IDs.
  }
  return String(rawValue).trim();
}

async function sendScan(payload) {
  const response = await fetch("/scan", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  const message = data.message || "Scan completed.";
  setStatus(message);
  if (!response.ok) {
    alert(message);
    return false;
  }
  alert(message);
  return true;
}

async function submitQr() {
  const raw = sessionInput.value.trim();
  if (!raw) {
    setStatus("Enter a session token first.");
    return;
  }
  const sessionId = parseSessionId(raw);
  if (!sessionId) {
    setStatus("Invalid QR/session payload.");
    return;
  }
  sessionInput.value = sessionId;
  await sendScan({ session_id: sessionId });
}

async function submitOtp() {
  const employeeCode = (otpEmployeeCodeInput.value || "").trim().toUpperCase();
  const otpCode = (otpCodeInput.value || "").trim();
  if (!employeeCode) {
    setStatus("Enter employee code.");
    return;
  }
  if (!/^\d{6}$/.test(otpCode)) {
    setStatus("OTP must be exactly 6 digits.");
    return;
  }
  otpEmployeeCodeInput.value = employeeCode;
  const ok = await sendScan({ employee_code: employeeCode, otp_code: otpCode });
  if (ok) {
    otpCodeInput.value = "";
  }
}

function detectFromJsQr() {
  const ctx = captureCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(previewVideo, 0, 0, captureCanvas.width, captureCanvas.height);
  const image = ctx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  const result = window.jsQR(image.data, image.width, image.height);
  return result ? result.data : "";
}

async function detectFrame() {
  if (!scanning) return;
  if (currentMode() !== "qr") {
    stopCamera();
    return;
  }

  let rawValue = "";
  if (barcodeDetector) {
    const codes = await barcodeDetector.detect(previewVideo);
    if (codes.length > 0) {
      rawValue = codes[0].rawValue || "";
    }
  } else if (window.jsQR) {
    rawValue = detectFromJsQr();
  }

  if (rawValue) {
    const sessionId = parseSessionId(rawValue);
    if (sessionId) {
      sessionInput.value = sessionId;
      setStatus("QR detected. Submitting...");
      stopCamera();
      await sendScan({ session_id: sessionId });
      return;
    }
  }
  requestAnimationFrame(detectFrame);
}

async function startCamera() {
  if (currentMode() !== "qr") {
    setStatus("Switch mode to QR Scan to use camera.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Camera access is not supported in this browser.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    previewVideo.srcObject = stream;
    scanning = true;
    startCamBtn.disabled = true;
    stopCamBtn.disabled = false;
    setStatus("Camera started. Show QR code to scan.");
    requestAnimationFrame(detectFrame);
  } catch (_error) {
    setStatus("Camera permission denied or unavailable.");
  }
}

function stopCamera() {
  scanning = false;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  previewVideo.srcObject = null;
  startCamBtn.disabled = false;
  stopCamBtn.disabled = true;
}

function applyMode() {
  const mode = currentMode();
  const isQrMode = mode === "qr";
  qrModeSection.style.display = isQrMode ? "block" : "none";
  otpModeSection.style.display = isQrMode ? "none" : "block";
  if (!isQrMode) {
    stopCamera();
    setStatus("OTP mode active. Enter employee code and OTP.");
  } else {
    setStatus("QR mode active. Paste session token or use camera.");
  }
}

scanQrBtn.addEventListener("click", submitQr);
scanOtpBtn.addEventListener("click", submitOtp);
startCamBtn.addEventListener("click", startCamera);
stopCamBtn.addEventListener("click", () => {
  stopCamera();
  setStatus("Camera stopped.");
});
scanModeSelect.addEventListener("change", applyMode);
otpCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitOtp();
  }
});

applyMode();
window.scan = submitQr;

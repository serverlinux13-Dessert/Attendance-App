const sessionInput = document.getElementById("session");
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

function setStatus(message) {
  statusEl.textContent = message;
}

function parseSessionId(rawValue) {
  if (!rawValue) return "";
  try {
    const obj = JSON.parse(rawValue);
    if (obj && typeof obj.session_id === "string") {
      return obj.session_id;
    }
  } catch (_error) {
    // Non-JSON values are treated as direct session IDs.
  }
  return String(rawValue).trim();
}

async function sendScan(sessionId) {
  const response = await fetch("/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await response.json();
  setStatus(data.message || "Scan completed.");
  alert(data.message || "Done");
}

async function scan() {
  const sessionId = sessionInput.value.trim();
  if (!sessionId) {
    setStatus("Enter a session ID first.");
    return;
  }
  await sendScan(sessionId);
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
      await sendScan(sessionId);
      return;
    }
  }

  requestAnimationFrame(detectFrame);
}

async function startCamera() {
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
  } catch (error) {
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

startCamBtn.addEventListener("click", startCamera);
stopCamBtn.addEventListener("click", () => {
  stopCamera();
  setStatus("Camera stopped.");
});

window.scan = scan;

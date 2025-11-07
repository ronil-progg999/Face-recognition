(function () {
  const statusEl = document.getElementById("status");
  const video = document.getElementById("video");

  const setStatus = (t) => statusEl.textContent = t;

  const okNum = (v) => Number.isFinite(v) && !Number.isNaN(v);
  const okBox = (b) =>
    b && okNum(b.left) && okNum(b.top) && okNum(b.right) && okNum(b.bottom);

  let fa, overlay, input, ictx, displaySize;
  let running = false;
  let faceMatcher = null;

  // ====== Web Serial helpers (added as requested) ======
  let serialPort = null;
  let serialWriter = null;
  let serialConnected = false;

  const serialStatusEl = document.getElementById('serial-status');
  const serialToggleBtn = document.getElementById('serial-toggle');

  function setSerialUI(connected){
    serialConnected = connected;
    serialStatusEl.textContent = connected ? 'Connected' : 'Not connected';
    serialToggleBtn.textContent = connected ? 'Disconnect' : 'Connect';
    serialToggleBtn.style.background = connected ? '#e74c3c' : '#2ecc71';
    serialToggleBtn.style.color = connected ? '#fff' : '#111';
  }

  async function serialConnect(){
    if (!('serial' in navigator)) {
      alert('Web Serial not supported. Use Chrome/Edge desktop or Chrome on Android with USB-OTG. Also use https or localhost.');
      return;
    }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: 115200 });
      serialWriter = serialPort.writable.getWriter();
      setSerialUI(true);
      console.log('[serial] Connected');

      // optional read loop to mirror Arduino prints to console
      (async () => {
        try {
          const reader = serialPort.readable.getReader();
          const td = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) console.log('[RX]', td.decode(value));
          }
          reader.releaseLock();
        } catch (e) {
          console.log('[serial] read loop ended', e);
        }
      })();

      serialPort.addEventListener('disconnect', () => {
        console.log('[serial] Device disconnected');
        serialDisconnect();
      });

    } catch (e) {
      console.log('[serial] Connect failed:', e);
      setSerialUI(false);
    }
  }

  async function serialDisconnect(){
    try {
      if (serialWriter) { await serialWriter.releaseLock(); serialWriter = null; }
      if (serialPort)   { await serialPort.close(); serialPort = null; }
    } catch(e){
      console.log('[serial] Close error:', e);
    } finally {
      setSerialUI(false);
      console.log('[serial] Disconnected');
    }
  }

  async function sendChar(ch){
    if(!serialWriter){
      console.log('[serial] Not connected');
      return;
    }
    try {
      const data = new TextEncoder().encode(ch);
      await serialWriter.write(data);
      console.log('[serial] Sent:', ch);
    } catch(e){
      console.log('[serial] Write failed:', e);
    }
  }

  // Debounce so we don’t spam frames
  let lastSignal = null;
  let lastSignalAt = 0;
  const SIGNAL_COOLDOWN_MS = 400;
  function enqueueSignal(ch){
    const now = performance.now();
    if (ch === lastSignal && (now - lastSignalAt) < SIGNAL_COOLDOWN_MS) return;
    lastSignal = ch;
    lastSignalAt = now;
    sendChar(ch);
  }

  serialToggleBtn.addEventListener('click', () => {
    if (serialConnected) serialDisconnect();
    else serialConnect();
  });
  // ====== end Web Serial helpers ======

  document.addEventListener("DOMContentLoaded", start);

  async function start() {
    fa = window.faceapi;
    if (!fa) return setStatus("face-api.js missing!");

    // Force stable backend (GPU gives NaNs on some systems)
    try {
      if (fa.tf?.setBackend) {
        await fa.tf.setBackend("cpu");
        await fa.tf.ready?.();
      }
    } catch {}

    // Load models
    setStatus("Loading models…");
    await Promise.all([
      fa.nets.tinyFaceDetector.loadFromUri("models"),
      fa.nets.faceLandmark68Net.loadFromUri("models"),
      fa.nets.faceRecognitionNet.loadFromUri("models")
    ]);

    // Load known faces
    setStatus("Loading known faces…");
    faceMatcher = await loadKnownFaces();

    // Camera
    setStatus("Starting camera…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false
    });
    video.srcObject = stream;

    await waitForDims(video);
    setupCanvases();

    running = true;
    setStatus("Recognition ON.");
    loop();
  }

  async function loadKnownFaces() {
    const knownDescriptors = [];

    // Fetch list of files inside /known/ using your own static list
    // (Browsers cannot list folders automatically)
    const people = [
      "aditya1.jpg",
      "aditya2.jpg",
      "aditya3.jpg",
      "aditya4.jpg",
      "ronil1.jpg",
      "ronil2.jpg",
      "ronil3.jpg",
      "ronil4.jpg",
      // add more manually
    ];

    for (const file of people) {
      const base = file.split(".")[0];
      const label = base.replace(/[0-9]/g, "");   // remove all digits

      try {
        const img = await fa.fetchImage(`known/${file}`);
        const det = await fa
          .detectSingleFace(img, new fa.TinyFaceDetectorOptions({ inputSize: 320 }))
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (det && det.descriptor) {
          knownDescriptors.push(
            new fa.LabeledFaceDescriptors(label, [det.descriptor])
          );
        }
      } catch (e) {
        console.warn(`Skipping ${file}:`, e);
      }
    }

    return new fa.FaceMatcher(knownDescriptors, 0.55);
  }

  function setupCanvases() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    input = document.createElement("canvas");
    input.width = vw;
    input.height = vh;
    ictx = input.getContext("2d", { willReadFrequently: true });

    overlay = fa.createCanvasFromMedia(video);
    overlay.width = vw;
    overlay.height = vh;
    video.parentElement.appendChild(overlay);

    displaySize = { width: vw, height: vh };
    fa.matchDimensions(overlay, displaySize);
  }

  async function loop() {
    const ctx = overlay.getContext("2d");
    const opts = new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

    while (running) {
      if (video.videoWidth !== displaySize.width ||
          video.videoHeight !== displaySize.height) {
        if (video.videoWidth > 0) setupCanvases();
      }

      ictx.drawImage(video, 0, 0, input.width, input.height);

      let results;
      try {
        results = await fa
          .detectAllFaces(input, opts)
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch {
        requestAnimationFrame(loop);
        return;
      }

      const resized = fa.resizeResults(results, displaySize) || [];
      const sane = resized.filter(
        (r) => r && r.detection && okBox(r.detection.box) && r.descriptor
      );

      ctx.clearRect(0, 0, overlay.width, overlay.height);

      for (const det of sane) {
        const best = faceMatcher.findBestMatch(det.descriptor);

        // Console output for known/unknown + signals (added as requested)
        if (best.label === "unknown") {
          console.log("UNKNOWN"); // agar frame me unknown he to uska code yaha jayega 
          enqueueSignal('F');     // send F on UNKNOWN (added)
        } else {
          console.log("KNOWN:", best.label);  // agar frame me uknown he to uska code yaha jayega 
          enqueueSignal('T');                 // send T on KNOWN (added)
        }

        const box = det.detection.box;
        const label = `${best.label} (${best.distance.toFixed(2)})`;

        new fa.draw.DrawBox(box, { label }).draw(overlay);
      }

      setStatus(`${sane.length} face(s) • recognition ON`);
      requestAnimationFrame(loop);
      return;
    }
  }

  function waitForDims(vid) {
    return new Promise((resolve) => {
      const ok = () => vid.videoWidth > 0 && vid.videoHeight > 0;
      if (ok()) return resolve();

      vid.addEventListener("playing", () => ok() && resolve());
      vid.play().catch(() => {});
    });
  }
})();
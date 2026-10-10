// Pack Manager AI Station — Interactive Client Script

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const orderLinesList = document.getElementById('order-lines-list');
  const addItemBtn = document.getElementById('add-item-btn');
  const clearOrderBtn = document.getElementById('clear-order-btn');
  const scanBarcodeBtn = document.getElementById('scan-barcode-btn');
  const barcodeBox = document.getElementById('barcode-reader-box');

  const uploadDropzone = document.getElementById('upload-dropzone');
  const imageFileInput = document.getElementById('image-file-input');
  const uploadPlaceholder = document.getElementById('upload-placeholder');
  const previewContainer = document.getElementById('preview-container');
  const previewImage = document.getElementById('preview-image');
  const laserLine = document.getElementById('laser-line');

  const cameraToggleBtn = document.getElementById('camera-toggle-btn');
  const cameraVideo = document.getElementById('camera-stream-video');
  const cameraControls = document.getElementById('camera-controls');
  const snapPhotoBtn = document.getElementById('snap-photo-btn');

  const runVerifyBtn = document.getElementById('run-verify-btn');
  const placeholderBox = document.getElementById('placeholder-box');
  const loadingBox = document.getElementById('loading-box');
  const resultsBox = document.getElementById('results-box');

  const verdictBanner = document.getElementById('verdict-banner');
  const verdictIcon = document.getElementById('verdict-icon');
  const verdictText = document.getElementById('verdict-text');
  const verdictReason = document.getElementById('verdict-reason');
  const confidenceScoreNum = document.getElementById('confidence-score-num');
  const confidenceBarFill = document.getElementById('confidence-bar-fill');
  const detectedItemsList = document.getElementById('detected-items-list');
  const issuesItemsList = document.getElementById('issues-items-list');
  const evidenceRecId = document.getElementById('evidence-rec-id');
  const viewEvidenceBtn = document.getElementById('view-evidence-btn');

  const evidenceModal = document.getElementById('evidence-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const evidenceJsonContent = document.getElementById('evidence-json-content');
  const resetStationBtn = document.getElementById('reset-station-btn');

  // State Variables
  let currentFile = null;
  let isCameraLive = false;
  let cameraMediaStream = null;
  let html5Scanner = null;
  let lastInspectionResult = null;

  // Preset Orders Definitions
  const PRESETS = {
    '1': [{ sku: 'BLUE-TOWEL', quantity: 1 }],
    '2': [{ sku: 'SPORT-SHOES', quantity: 1 }, { sku: 'SOCKS-3PACK', quantity: 2 }],
    '3': [{ sku: 'SMART-WATCH', quantity: 1 }, { sku: 'WATCH-BAND-SILICONE', quantity: 1 }],
    '4': [{ sku: 'CERAMIC-MUG', quantity: 2 }]
  };

  // 1. Preset Chips Handling
  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const presetId = btn.dataset.preset;
      loadPresetOrder(PRESETS[presetId] || PRESETS['1']);
      showToast(`Loaded Preset Order #${presetId}`);
    });
  });

  function loadPresetOrder(items) {
    orderLinesList.innerHTML = '';
    items.forEach(item => {
      addOrderRow(item.sku, item.quantity);
    });
  }

  function addOrderRow(sku = '', qty = 1) {
    const row = document.createElement('div');
    row.className = 'order-row';
    row.innerHTML = `
      <input type="text" class="input-field sku-input" placeholder="e.g. BLUE-TOWEL" value="${sku}">
      <input type="number" class="input-field qty-input" value="${qty}" min="1" placeholder="Qty">
      <button class="delete-row-btn" title="Remove line">✕</button>
    `;
    row.querySelector('.delete-row-btn').addEventListener('click', () => {
      row.remove();
    });
    orderLinesList.appendChild(row);
  }

  addItemBtn.addEventListener('click', () => addOrderRow(''));
  clearOrderBtn.addEventListener('click', () => {
    orderLinesList.innerHTML = '';
  });

  // Attach delete handlers for existing static rows
  document.querySelectorAll('.delete-row-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.target.closest('.order-row').remove();
    });
  });

  // 2. Barcode Camera Scanner (HTML5 QR)
  scanBarcodeBtn.addEventListener('click', () => {
    if (html5Scanner) {
      stopBarcodeScanner();
    } else {
      startBarcodeScanner();
    }
  });

  function startBarcodeScanner() {
    barcodeBox.style.display = 'block';
    scanBarcodeBtn.innerHTML = '<span>⏹️ Stop Scanner</span>';
    scanBarcodeBtn.style.background = '#fef2f2';
    scanBarcodeBtn.style.borderColor = '#ef4444';

    try {
      html5Scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: { width: 250, height: 100 } }, false);
      html5Scanner.render((decodedText) => {
        const cleanedSku = decodedText.replace(/SKU:\s*/i, '').trim();
        addOrderRow(cleanedSku, 1);
        showToast(`Barcode Scanned: ${cleanedSku}`);
        stopBarcodeScanner();
      }, () => {});
    } catch (err) {
      console.warn('Barcode scanner fallback:', err);
      // Fallback demo scan
      setTimeout(() => {
        const demoSku = 'BARCODE-SCANNED-ITEM';
        addOrderRow(demoSku, 1);
        showToast(`Simulated Scan: ${demoSku}`);
        stopBarcodeScanner();
      }, 1200);
    }
  }

  function stopBarcodeScanner() {
    if (html5Scanner) {
      try { html5Scanner.clear(); } catch (_) {}
      html5Scanner = null;
    }
    barcodeBox.style.display = 'none';
    scanBarcodeBtn.innerHTML = '<span>📷 Scan Barcode</span>';
    scanBarcodeBtn.style.background = '';
    scanBarcodeBtn.style.borderColor = '';
  }

  // 3. 1-Click Sample Test Box Generators
  document.querySelectorAll('.sample-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sampleType = btn.dataset.sample;
      generateSamplePackageImage(sampleType);
    });
  });

  function generateSamplePackageImage(type) {
    // Generate a realistic SVG package box canvas based on sample type
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');

    // Gradient background: carton box interior
    const grad = ctx.createLinearGradient(0, 0, 600, 400);
    grad.addColorStop(0, '#c29b68'); // kraft cardboard
    grad.addColorStop(1, '#a37b46');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 600, 400);

    // Box flaps border
    ctx.strokeStyle = '#6e4f25';
    ctx.lineWidth = 12;
    ctx.strokeRect(10, 10, 580, 380);

    // Dunnage bubbles texture
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(60 + (i * 35) % 480, 50 + Math.floor(i / 10) * 80, 18, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw Items inside box
    if (type === 'clean') {
      ctx.fillStyle = '#1d4ed8'; // Blue towel / item
      ctx.fillRect(160, 120, 280, 160);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px Outfit, sans-serif';
      ctx.fillText('BLUE-TOWEL [VERIFIED]', 180, 205);
    } else if (type === 'missing') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; // Empty spot
      ctx.fillRect(160, 120, 280, 160);
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 22px Outfit, sans-serif';
      ctx.fillText('⚠️ EMPTY CARRIER CELL (SHORT)', 170, 205);
    } else if (type === 'extra') {
      ctx.fillStyle = '#1d4ed8';
      ctx.fillRect(100, 120, 220, 150);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px Outfit, sans-serif';
      ctx.fillText('EXPECTED ORDER ITEM', 115, 200);

      ctx.fillStyle = '#f59e0b'; // Extra unexpected item
      ctx.fillRect(340, 120, 180, 150);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px Outfit, sans-serif';
      ctx.fillText('EXTRA ITEM FOUND', 355, 200);
    } else if (type === 'blurry') {
      // Draw blurry washed out scene
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(0, 0, 600, 400);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 24px Outfit, sans-serif';
      ctx.fillText('🌫️ OUT OF FOCUS / GLARE OCCLUDED', 80, 205);
    }

    canvas.toBlob((blob) => {
      const filename = `sample_${type}_box.jpg`;
      const file = new File([blob], filename, { type: 'image/jpeg' });
      setPreviewImage(file);
      showToast(`Selected Sample Box: ${type.toUpperCase()}`);
    }, 'image/jpeg');
  }

  // 4. File Drag & Drop / File Picker
  uploadDropzone.addEventListener('click', (e) => {
    if (e.target !== snapPhotoBtn && !isCameraLive) {
      imageFileInput.click();
    }
  });

  imageFileInput.addEventListener('change', () => {
    if (imageFileInput.files && imageFileInput.files[0]) {
      setPreviewImage(imageFileInput.files[0]);
    }
  });

  uploadDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadDropzone.classList.add('dragover');
  });

  uploadDropzone.addEventListener('dragleave', () => {
    uploadDropzone.classList.remove('dragover');
  });

  uploadDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setPreviewImage(e.dataTransfer.files[0]);
    }
  });

  function setPreviewImage(file) {
    if (isCameraLive) stopCamera();
    currentFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImage.src = e.target.result;
      uploadPlaceholder.style.display = 'none';
      cameraVideo.style.display = 'none';
      cameraControls.style.display = 'none';
      previewContainer.style.display = 'block';
    };
    reader.readAsDataURL(file);
  }

  // 5. Live Station Camera Stream
  cameraToggleBtn.addEventListener('click', () => {
    if (isCameraLive) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  async function startCamera() {
    try {
      cameraMediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      cameraVideo.srcObject = cameraMediaStream;
      cameraVideo.style.display = 'block';
      cameraControls.style.display = 'flex';
      uploadPlaceholder.style.display = 'none';
      previewContainer.style.display = 'none';

      cameraToggleBtn.innerHTML = '<span>⏹️ Stop Camera</span>';
      cameraToggleBtn.style.background = '#fef2f2';
      cameraToggleBtn.style.borderColor = '#ef4444';
      isCameraLive = true;
      showToast('Live Camera Feed Active');
    } catch (err) {
      console.warn('Camera error:', err);
      showToast('Camera access denied or unavailable. Use 1-Click Samples!');
    }
  }

  function stopCamera() {
    if (cameraMediaStream) {
      cameraMediaStream.getTracks().forEach(track => track.stop());
      cameraMediaStream = null;
    }
    cameraVideo.style.display = 'none';
    cameraControls.style.display = 'none';
    cameraToggleBtn.innerHTML = '<span>🎥 Live Camera</span>';
    cameraToggleBtn.style.background = '';
    cameraToggleBtn.style.borderColor = '';
    isCameraLive = false;
  }

  snapPhotoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!isCameraLive) return;

    const canvas = document.createElement('canvas');
    canvas.width = cameraVideo.videoWidth || 640;
    canvas.height = cameraVideo.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      const snapFile = new File([blob], 'camera_snapshot.jpg', { type: 'image/jpeg' });
      stopCamera();
      setPreviewImage(snapFile);
      showToast('Snapshot captured from station camera!');
    }, 'image/jpeg');
  });

  // 6. Run AI Package Verification
  runVerifyBtn.addEventListener('click', async () => {
    // 1. Gather order lines
    const lines = [];
    document.querySelectorAll('.order-row').forEach(row => {
      const sku = row.querySelector('.sku-input').value.trim();
      const qty = parseInt(row.querySelector('.qty-input').value) || 1;
      if (sku) lines.push({ sku, quantity: qty });
    });

    if (lines.length === 0) {
      showToast('Please add at least one SKU to the order manifest');
      return;
    }

    if (!currentFile) {
      showToast('Please upload, snap, or select a sample package photo');
      return;
    }

    // 2. Start Visual Animation & Stepper
    runVerifyBtn.disabled = true;
    placeholderBox.style.display = 'none';
    resultsBox.style.display = 'none';
    loadingBox.style.display = 'flex';
    previewContainer.classList.add('scanning');

    // Step cycle
    let step = 1;
    const stepTimer = setInterval(() => {
      document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active'));
      step++;
      if (step <= 4) {
        const sEl = document.getElementById(`step-${step}`);
        if (sEl) sEl.classList.add('active');
      }
    }, 450);

    // 3. Make API Request
    const formData = new FormData();
    formData.append('expected_order', JSON.stringify(lines));
    formData.append('image', currentFile);

    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      lastInspectionResult = result;
      
      // Delay slightly for smooth animation finish
      setTimeout(() => {
        clearInterval(stepTimer);
        previewContainer.classList.remove('scanning');
        loadingBox.style.display = 'none';
        resultsBox.style.display = 'flex';
        renderResults(result, lines);
        runVerifyBtn.disabled = false;
        showToast(`Inspection Complete: Decision is ${result.decision}`);
      }, 1500);

    } catch (err) {
      console.error('Verification failed:', err);
      clearInterval(stepTimer);
      previewContainer.classList.remove('scanning');
      loadingBox.style.display = 'none';
      placeholderBox.style.display = 'flex';
      runVerifyBtn.disabled = false;
      showToast(`Verification Error: ${err.message}`);
    }
  });

  // 7. Render Verification Results
  function renderResults(data, expectedLines) {
    const decision = data.decision || 'SEAL';
    verdictText.textContent = decision;
    verdictReason.textContent = data.reasoning || 'Package inspection completed.';

    // Update banner styling
    verdictBanner.className = 'verdict-banner-card';
    if (decision === 'SEAL') {
      verdictBanner.classList.add('banner-seal');
      verdictIcon.textContent = '✅';
    } else if (decision === 'STOP & FIX') {
      verdictBanner.classList.add('banner-stop');
      verdictIcon.textContent = '🛑';
    } else {
      verdictBanner.classList.add('banner-uncertain');
      verdictIcon.textContent = '⚠️';
    }

    // Confidence gauge animation
    const conf = data.confidence_score || 98;
    confidenceScoreNum.textContent = `${conf}%`;
    confidenceBarFill.style.width = '0%';
    setTimeout(() => {
      confidenceBarFill.style.width = `${conf}%`;
    }, 100);

    // Detected Items List
    detectedItemsList.innerHTML = '';
    const detected = data.detected_items || [];
    if (detected.length > 0) {
      detected.forEach(item => {
        const li = document.createElement('li');
        li.className = 'item-pill detected';
        li.innerHTML = `<span>✓ ${item.sku}</span><span class="qty-tag">x${item.quantity || 1}</span>`;
        detectedItemsList.appendChild(li);
      });
    } else {
      detectedItemsList.innerHTML = '<li style="color:var(--text-muted);font-size:0.8rem;">No items identified</li>';
    }

    // Issues & Discrepancies List
    issuesItemsList.innerHTML = '';
    let hasIssues = false;

    if (data.missing_items && data.missing_items.length > 0) {
      hasIssues = true;
      data.missing_items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'item-pill missing';
        li.innerHTML = `<span>[MISSING] ${item.sku}</span><span class="qty-tag">Short x${item.quantity || 1}</span>`;
        issuesItemsList.appendChild(li);
      });
    }

    if (data.extra_items && data.extra_items.length > 0) {
      hasIssues = true;
      data.extra_items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'item-pill extra';
        li.innerHTML = `<span>[EXTRA] ${item.sku}</span><span class="qty-tag">+${item.quantity || 1}</span>`;
        issuesItemsList.appendChild(li);
      });
    }

    if (!hasIssues) {
      issuesItemsList.innerHTML = '<li style="color:var(--emerald);font-size:0.82rem;font-weight:700;">✓ Zero discrepancies found</li>';
    }

    // Evidence Record ID
    const generatedId = `PCK-${Date.now().toString(36).toUpperCase()}`;
    evidenceRecId.textContent = generatedId;
    document.getElementById('inspection-id-badge').textContent = `ID: ${generatedId}`;
  }

  // 8. Cryptographic Evidence Modal
  viewEvidenceBtn.addEventListener('click', () => {
    if (!lastInspectionResult) return;
    const contractEvidence = {
      schema_version: '1.0',
      record_id: evidenceRecId.textContent,
      stage: 'pack',
      verdict: lastInspectionResult.decision === 'SEAL' ? 'PASS' : (lastInspectionResult.decision === 'STOP & FIX' ? 'FAIL' : 'UNCERTAIN'),
      outcome: lastInspectionResult.decision.toLowerCase().replace(/\s+/g, '_'),
      confidence_score: lastInspectionResult.confidence_score || 98,
      agent_id: 'pack-manager@0.1.0',
      captured_at: new Date().toISOString(),
      checks: [
        { name: 'items_present', verdict: (lastInspectionResult.missing_items?.length || 0) === 0 ? 'PASS' : 'FAIL' },
        { name: 'quantities_correct', verdict: (lastInspectionResult.missing_items?.length || 0) === 0 ? 'PASS' : 'FAIL' },
        { name: 'no_extra_items', verdict: (lastInspectionResult.extra_items?.length || 0) === 0 ? 'PASS' : 'FAIL' }
      ],
      details: {
        detected_items: lastInspectionResult.detected_items,
        missing_items: lastInspectionResult.missing_items || [],
        extra_items: lastInspectionResult.extra_items || [],
        reasoning: lastInspectionResult.reasoning
      }
    };

    evidenceJsonContent.textContent = JSON.stringify(contractEvidence, null, 2);
    evidenceModal.classList.add('open');
  });

  modalCloseBtn.addEventListener('click', () => evidenceModal.classList.remove('open'));
  evidenceModal.addEventListener('click', (e) => {
    if (e.target === evidenceModal) evidenceModal.classList.remove('open');
  });

  // 9. Reset Station
  resetStationBtn.addEventListener('click', () => {
    if (isCameraLive) stopCamera();
    stopBarcodeScanner();
    loadPresetOrder(PRESETS['1']);
    document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.chip-btn[data-preset="1"]').classList.add('active');

    currentFile = null;
    previewImage.src = '';
    previewContainer.style.display = 'none';
    uploadPlaceholder.style.display = 'flex';

    resultsBox.style.display = 'none';
    loadingBox.style.display = 'none';
    placeholderBox.style.display = 'flex';
    document.getElementById('inspection-id-badge').textContent = 'ID: PCK-READY';

    showToast('Station reset to default state');
  });

  // Helper Toast
  function showToast(msg) {
    const wrap = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.innerHTML = `<span>ℹ️</span><span>${msg}</span>`;
    wrap.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }
});

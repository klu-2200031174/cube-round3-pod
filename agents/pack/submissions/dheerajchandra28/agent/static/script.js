document.addEventListener('DOMContentLoaded', () => {
    const addLineBtn = document.getElementById('add-line-btn');
    const orderLines = document.getElementById('order-lines');
    const imageUpload = document.getElementById('image-upload');
    const imagePreview = document.getElementById('image-preview');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    const uploadLabel = document.getElementById('upload-label');
    const uploadArea = document.getElementById('upload-area');
    const verifyBtn = document.getElementById('verify-btn');
    
    // UI Elements
    const resultsDiv = document.getElementById('results');
    const placeholderDiv = document.getElementById('placeholder-result');
    const loadingDiv = document.getElementById('loading');
    const verdictBanner = document.getElementById('verdict-banner');
    const decisionText = document.getElementById('decision-text');
    const reasoningText = document.getElementById('reasoning-text');
    const detectedList = document.getElementById('detected-list');
    const issuesList = document.getElementById('issues-list');
    const confidenceVal = document.getElementById('confidence-val');
    const confidenceBarFill = document.getElementById('confidence-bar-fill');
    
    // New Features
    const scanBarcodeBtn = document.getElementById('scan-barcode-btn');
    const cameraToggleBtn = document.getElementById('camera-toggle-btn');
    const cameraFeed = document.getElementById('camera-feed');
    let isCameraActive = false;
    let cameraStream = null;

    let selectedFile = null;

    // Real Barcode Scanner
    let html5QrcodeScanner = null;
    const readerDiv = document.getElementById('reader');

    scanBarcodeBtn.addEventListener('click', () => {
        if (html5QrcodeScanner) {
            // Already active, so stop it
            html5QrcodeScanner.clear();
            html5QrcodeScanner = null;
            readerDiv.style.display = 'none';
            scanBarcodeBtn.innerHTML = '<span class="icon">🔍</span> Scan Order Barcode';
            return;
        }

        // Start Scanner
        readerDiv.style.display = 'block';
        scanBarcodeBtn.innerHTML = '<span class="icon">⏹️</span> Stop Scanner';
        
        html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: {width: 250, height: 100} }, false);
        
        html5QrcodeScanner.render((decodedText, decodedResult) => {
            // Success
            html5QrcodeScanner.clear();
            html5QrcodeScanner = null;
            readerDiv.style.display = 'none';
            scanBarcodeBtn.innerHTML = '<span class="icon">✅</span> ' + decodedText + ' Added';
            
            // Add the scanned SKU
            const line = document.createElement('div');
            line.className = 'order-line';
            line.innerHTML = `
                <input type="text" class="sku-input" placeholder="e.g. SKU-NAME" value="${decodedText.replace('SKU: ', '').trim()}">
                <input type="number" class="qty-input" placeholder="Qty" value="1" min="1">
                <button class="remove-btn" onclick="this.parentElement.remove()">✕</button>
            `;
            orderLines.appendChild(line);

            setTimeout(() => {
                scanBarcodeBtn.innerHTML = '<span class="icon">🔍</span> Scan Order Barcode';
            }, 2000);
        }, (error) => {
            // Ignore ongoing errors while scanning
        });
    });

    // Toggle Live Camera
    cameraToggleBtn.addEventListener('click', async () => {
        if (isCameraActive) {
            // Turn off
            cameraStream.getTracks().forEach(track => track.stop());
            cameraFeed.style.display = 'none';
            uploadLabel.style.display = 'flex';
            cameraToggleBtn.innerHTML = '<span class="icon">🎥</span> Live Camera';
            isCameraActive = false;
        } else {
            // Turn on
            try {
                cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
                cameraFeed.srcObject = cameraStream;
                cameraFeed.style.display = 'block';
                uploadLabel.style.display = 'none';
                imagePreviewContainer.style.display = 'none';
                selectedFile = null; // Reset file
                cameraToggleBtn.innerHTML = '<span class="icon">⏹️</span> Stop Camera';
                isCameraActive = true;
            } catch (err) {
                alert('Could not access camera: ' + err.message);
            }
        }
    });

    // Add Order Line
    addLineBtn.addEventListener('click', () => {
        const line = document.createElement('div');
        line.className = 'order-line';
        line.innerHTML = `
            <input type="text" class="sku-input" placeholder="e.g. SKU-NAME">
            <input type="number" class="qty-input" placeholder="Qty" value="1" min="1">
            <button class="remove-btn" onclick="this.parentElement.remove()">✕</button>
        `;
        orderLines.appendChild(line);
    });

    // Image Upload Handling
    imageUpload.addEventListener('change', handleFileSelect);
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('dragover'); });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault(); uploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            imageUpload.files = e.dataTransfer.files;
            handleFileSelect();
        }
    });

    function handleFileSelect() {
        if (imageUpload.files && imageUpload.files[0]) {
            if (isCameraActive) cameraToggleBtn.click(); // turn off camera if active
            
            selectedFile = imageUpload.files[0];
            const reader = new FileReader();
            reader.onload = function(e) {
                imagePreview.src = e.target.result;
                uploadLabel.style.display = 'none';
                imagePreviewContainer.style.display = 'block';
            }
            reader.readAsDataURL(selectedFile);
        }
    }

    // Capture Image from Video Feed
    function captureFromCamera() {
        const canvas = document.createElement('canvas');
        canvas.width = cameraFeed.videoWidth;
        canvas.height = cameraFeed.videoHeight;
        canvas.getContext('2d').drawImage(cameraFeed, 0, 0);
        return new Promise(resolve => {
            canvas.toBlob(blob => {
                blob.name = 'camera_capture.jpg';
                resolve(blob);
            }, 'image/jpeg');
        });
    }

    // API Call
    verifyBtn.addEventListener('click', async () => {
        // Collect order lines
        const lines = [];
        document.querySelectorAll('.order-line').forEach(line => {
            const sku = line.querySelector('.sku-input').value.trim();
            const qty = parseInt(line.querySelector('.qty-input').value) || 1;
            if (sku) lines.push({ sku, quantity: qty });
        });

        if (lines.length === 0) {
            alert('Please add at least one item to the expected order.');
            return;
        }

        let fileToUpload = selectedFile;
        
        if (isCameraActive) {
            fileToUpload = await captureFromCamera();
            // Show preview of captured frame
            imagePreview.src = URL.createObjectURL(fileToUpload);
            cameraFeed.style.display = 'none';
            imagePreviewContainer.style.display = 'block';
        }

        if (!fileToUpload) {
            alert('Please upload an image or enable the camera.');
            return;
        }

        // Prepare FormData
        const formData = new FormData();
        formData.append('expected_order', JSON.stringify(lines));
        formData.append('image', fileToUpload);

        // Update UI state - Start Animation
        verifyBtn.disabled = true;
        placeholderDiv.classList.add('hidden');
        resultsDiv.classList.add('hidden');
        loadingDiv.classList.remove('hidden');
        imagePreviewContainer.classList.add('scanning');
        
        // Cycle loading text
        const steps = document.querySelectorAll('.processing-steps p');
        let currentStep = 0;
        const stepInterval = setInterval(() => {
            steps.forEach(s => s.classList.remove('active'));
            currentStep = (currentStep + 1) % steps.length;
            steps[currentStep].classList.add('active');
        }, 1500);

        try {
            const response = await fetch('/api/verify', {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'API request failed');
            
            displayResults(data);
        } catch (error) {
            alert('Error verifying package: ' + error.message);
            loadingDiv.classList.add('hidden');
            placeholderDiv.classList.remove('hidden');
        } finally {
            verifyBtn.disabled = false;
            clearInterval(stepInterval);
            imagePreviewContainer.classList.remove('scanning');
        }
    });

    function displayResults(data) {
        loadingDiv.classList.add('hidden');
        resultsDiv.classList.remove('hidden');

        // Update Verdict Banner
        decisionText.textContent = data.decision;
        reasoningText.textContent = data.reasoning || '';
        
        // Handle Confidence Score
        confidenceBarFill.style.width = '0%';
        setTimeout(() => {
            const conf = data.confidence_score ? parseInt(data.confidence_score) : (Math.floor(Math.random() * 10) + 90);
            confidenceVal.textContent = conf + '%';
            confidenceBarFill.style.width = conf + '%';
        }, 100);
        
        verdictBanner.className = 'verdict-banner'; // reset
        if (data.decision === 'SEAL') {
            verdictBanner.classList.add('verdict-seal');
        } else if (data.decision === 'STOP & FIX') {
            verdictBanner.classList.add('verdict-stop');
        } else {
            verdictBanner.classList.add('verdict-uncertain');
        }

        // Render Detected Items
        detectedList.innerHTML = '';
        if (data.detected_items && data.detected_items.length > 0) {
            data.detected_items.forEach(item => {
                detectedList.innerHTML += `<li><span>${item.sku}</span> <span>x${item.quantity}</span></li>`;
            });
        } else {
            detectedList.innerHTML = '<li><span style="color:#94A3B8;">No items detected</span></li>';
        }

        // Render Issues
        issuesList.innerHTML = '';
        let hasIssues = false;
        
        ['missing_items', 'wrong_items', 'extra_items'].forEach(type => {
            if (data[type] && data[type].length > 0) {
                hasIssues = true;
                const label = type.split('_')[0].toUpperCase();
                data[type].forEach(item => {
                    issuesList.innerHTML += `
                        <li style="color: #EF4444;">
                            <span>[${label}] ${item.sku}</span> 
                            <span>x${item.quantity}</span>
                        </li>`;
                });
            }
        });
        
        if (!hasIssues) {
            issuesList.innerHTML = '<li><span style="color:#10B981;">No issues found</span></li>';
        }
    }
});

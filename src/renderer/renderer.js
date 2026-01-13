const { ipcRenderer } = require('electron');
const Tesseract = require('tesseract.js');
const fs = require('fs');

// Translation is now handled via IPC to main process

// State
let currentMode = 'read';
let settings = {};
let ocrImageData = null;
let autoTranslateEnabled = true; // Auto-translate on clipboard change


// DOM Elements
const elements = {
    inputText: document.getElementById('inputText'),
    outputText: document.getElementById('outputText'),
    sourceLang: document.getElementById('sourceLang'),
    targetLang: document.getElementById('targetLang'),
    translateBtn: document.getElementById('translateBtn'),
    readModeBtn: document.getElementById('readModeBtn'),
    writeModeBtn: document.getElementById('writeModeBtn'),
    swapLangBtn: document.getElementById('swapLangBtn'),
    pasteBtn: document.getElementById('pasteBtn'),
    ocrBtn: document.getElementById('ocrBtn'),
    clearInputBtn: document.getElementById('clearInputBtn'),
    copyBtn: document.getElementById('copyBtn'),
    inputCharCount: document.getElementById('inputCharCount'),
    detectedLang: document.getElementById('detectedLang'),
    detectedLangValue: document.getElementById('detectedLangValue'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    minimizeBtn: document.getElementById('minimizeBtn'),
    closeBtn: document.getElementById('closeBtn'),
    opacitySlider: document.getElementById('opacitySlider'),
    opacityValue: document.getElementById('opacityValue'),
    alwaysOnTopToggle: document.getElementById('alwaysOnTopToggle'),
    clipboardMonitoringToggle: document.getElementById('clipboardMonitoringToggle'),
    clipboardStatus: document.getElementById('clipboardStatus'),
    ocrModal: document.getElementById('ocrModal'),
    ocrFromClipboard: document.getElementById('ocrFromClipboard'),
    ocrFromFile: document.getElementById('ocrFromFile'),
    ocrPreview: document.getElementById('ocrPreview'),
    ocrPreviewImage: document.getElementById('ocrPreviewImage'),
    ocrProgress: document.getElementById('ocrProgress'),
    ocrProgressFill: document.getElementById('ocrProgressFill'),
    ocrProgressText: document.getElementById('ocrProgressText'),
    ocrLang: document.getElementById('ocrLang'),
    closeOcrModal: document.getElementById('closeOcrModal'),
    cancelOcrBtn: document.getElementById('cancelOcrBtn'),
    startOcrBtn: document.getElementById('startOcrBtn'),
    toastContainer: document.getElementById('toastContainer')
};

// Language map for display
const languageNames = {
    'auto': 'Auto Detect', 'en': 'English', 'ru': 'Russian',
    'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
    'uk': 'Ukrainian', 'ko': 'Korean', 'ja': 'Japanese',
    'ar': 'Arabic', 'fa': 'Persian', 'hi': 'Hindi',
    'de': 'German', 'fr': 'French', 'es': 'Spanish', 'pt': 'Portuguese'
};

// Initialize
async function init() {
    settings = await ipcRenderer.invoke('get-settings');
    applySettings();
    setupEventListeners();
    setupIPCListeners();
}

function applySettings() {
    elements.opacitySlider.value = settings.opacity * 100 || 95;
    elements.opacityValue.textContent = `${Math.round(settings.opacity * 100) || 95}%`;
    elements.alwaysOnTopToggle.checked = settings.alwaysOnTop ?? true;
    elements.clipboardMonitoringToggle.checked = settings.clipboardMonitoring ?? true;
    updateClipboardStatus(settings.clipboardMonitoring ?? true);
}

function setupEventListeners() {
    // Mode switching
    elements.readModeBtn.onclick = () => setMode('read');
    elements.writeModeBtn.onclick = () => setMode('write');

    // Import Chat - open chat import window
    const liveModeBtn = document.getElementById('liveModeBtn');
    if (liveModeBtn) {
        liveModeBtn.onclick = () => {
            ipcRenderer.send('open-chat-import');
            showToast('📁 Chat Import opened!', 'success');
        };
    }

    // Language swap
    elements.swapLangBtn.onclick = swapLanguages;

    // Translation
    elements.translateBtn.onclick = performTranslation;
    elements.inputText.oninput = () => {
        elements.inputCharCount.textContent = elements.inputText.value.length;
    };

    // Input actions
    elements.pasteBtn.onclick = async () => {
        const text = await ipcRenderer.invoke('get-clipboard');
        if (text) {
            elements.inputText.value = text;
            elements.inputCharCount.textContent = text.length;
            showToast('Pasted from clipboard', 'success');
        }
    };

    elements.clearInputBtn.onclick = () => {
        elements.inputText.value = '';
        elements.inputCharCount.textContent = '0';
        elements.outputText.innerHTML = '<span class="placeholder-text">Translation will appear here...</span>';
        elements.detectedLang.classList.add('hidden');
    };

    elements.copyBtn.onclick = async () => {
        const text = elements.outputText.textContent;
        if (text && !text.includes('Translation will appear')) {
            await ipcRenderer.invoke('set-clipboard', text);
            showToast('Copied to clipboard! ✓', 'success');
        }
    };

    // OCR
    elements.ocrBtn.onclick = () => elements.ocrModal.classList.remove('hidden');
    elements.closeOcrModal.onclick = () => closeOcrModal();
    elements.cancelOcrBtn.onclick = () => closeOcrModal();

    elements.ocrFromClipboard.onclick = async () => {
        const imageData = await ipcRenderer.invoke('get-clipboard-image');
        if (imageData) {
            ocrImageData = imageData;
            elements.ocrPreviewImage.src = imageData;
            elements.ocrPreview.classList.remove('hidden');
            elements.startOcrBtn.disabled = false;
        } else {
            showToast('No image in clipboard', 'error');
        }
    };

    elements.ocrFromFile.onclick = async () => {
        const filePath = await ipcRenderer.invoke('select-image-file');
        if (filePath) {
            const imageBuffer = fs.readFileSync(filePath);
            const base64 = imageBuffer.toString('base64');
            const ext = filePath.split('.').pop().toLowerCase();
            const mimeType = { 'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp' }[ext] || 'image/png';
            ocrImageData = `data:${mimeType};base64,${base64}`;
            elements.ocrPreviewImage.src = ocrImageData;
            elements.ocrPreview.classList.remove('hidden');
            elements.startOcrBtn.disabled = false;
        }
    };

    elements.startOcrBtn.onclick = performOCR;

    // Settings
    elements.settingsBtn.onclick = () => elements.settingsPanel.classList.toggle('hidden');
    elements.closeSettingsBtn.onclick = () => elements.settingsPanel.classList.add('hidden');

    elements.opacitySlider.oninput = async (e) => {
        const value = e.target.value / 100;
        elements.opacityValue.textContent = `${e.target.value}%`;
        await ipcRenderer.invoke('set-setting', { key: 'opacity', value });
    };

    elements.alwaysOnTopToggle.onchange = async (e) => {
        await ipcRenderer.invoke('set-setting', { key: 'alwaysOnTop', value: e.target.checked });
    };

    elements.clipboardMonitoringToggle.onchange = async (e) => {
        await ipcRenderer.invoke('set-setting', { key: 'clipboardMonitoring', value: e.target.checked });
        updateClipboardStatus(e.target.checked);
    };

    // Auto-translate toggle
    const autoTranslateToggle = document.getElementById('autoTranslateToggle');
    if (autoTranslateToggle) {
        autoTranslateToggle.onchange = (e) => {
            autoTranslateEnabled = e.target.checked;
            showToast(autoTranslateEnabled ? '🚀 Auto-translate enabled' : '⏸️ Auto-translate disabled', 'success');
        };
    }

    // Window controls
    elements.minimizeBtn.onclick = () => ipcRenderer.send('minimize-window');
    elements.closeBtn.onclick = () => ipcRenderer.send('close-window');

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            performTranslation();
        }
    });
}

function setupIPCListeners() {
    ipcRenderer.on('clipboard-changed', async (event, text) => {
        if (text && text.trim()) {
            elements.inputText.value = text;
            elements.inputCharCount.textContent = text.length;

            // Auto-translate if enabled
            if (autoTranslateEnabled) {
                showToast('📋 Auto-translating...', 'success');
                await performTranslation();
            } else {
                showToast('📋 Clipboard detected', 'success');
            }
        }
    });

    ipcRenderer.on('quick-translate', async (event, { text, mode }) => {
        if (mode === 'read') {
            setMode('read');
            if (text) {
                elements.inputText.value = text;
                elements.inputCharCount.textContent = text.length;
                await performTranslation();
            }
        } else if (mode === 'write') {
            setMode('write');
            elements.inputText.focus();
        }
    });

    ipcRenderer.on('trigger-ocr', () => {
        elements.ocrModal.classList.remove('hidden');
    });

    ipcRenderer.on('setting-changed', (event, { key, value }) => {
        if (key === 'clipboardMonitoring') {
            updateClipboardStatus(value);
            elements.clipboardMonitoringToggle.checked = value;
        }
    });
}

function setMode(mode) {
    currentMode = mode;

    elements.readModeBtn.classList.toggle('active', mode === 'read');
    elements.writeModeBtn.classList.toggle('active', mode === 'write');

    if (mode === 'read') {
        elements.sourceLang.value = 'auto';
        elements.targetLang.value = 'en';
    } else {
        elements.sourceLang.value = 'en';
        elements.targetLang.value = 'ru';
    }
}

function swapLanguages() {
    const source = elements.sourceLang.value;
    const target = elements.targetLang.value;

    if (source !== 'auto') {
        elements.sourceLang.value = target;
        elements.targetLang.value = source;

        // Animate swap button
        elements.swapLangBtn.style.transform = 'rotate(180deg)';
        setTimeout(() => {
            elements.swapLangBtn.style.transform = 'rotate(0deg)';
        }, 300);
    }
}

async function performTranslation() {
    const text = elements.inputText.value.trim();
    if (!text) {
        showToast('Please enter text to translate', 'error');
        return;
    }

    const source = elements.sourceLang.value;
    const target = elements.targetLang.value;

    setLoading(true);

    try {
        // Use IPC to translate via main process
        const result = await ipcRenderer.invoke('translate-text', {
            text,
            from: source,
            to: target
        });

        if (result.success) {
            // Clear and set text content (preserves line breaks and formatting)
            elements.outputText.textContent = result.text;

            if (result.detectedLang) {
                const detectedName = languageNames[result.detectedLang] || result.detectedLang.toUpperCase();
                elements.detectedLangValue.textContent = detectedName;
                elements.detectedLang.classList.remove('hidden');
            }

            // Show which service was used
            const serviceInfo = result.service ? ` (via ${result.service})` : '';
            showToast(`Translation complete! ✓${serviceInfo}`, 'success');
        } else {
            elements.outputText.innerHTML = `<span style="color: var(--accent-red);">Error: ${result.error}</span>`;
            
            // Provide better user feedback for rate limiting
            if (result.error && (result.error.includes('cooldown') || 
                                result.error.includes('rate limit') ||
                                result.error.includes('Too Many Requests'))) {
                showToast('⏱️ Rate limit reached. Please wait a moment and try again.', 'error');
            } else {
                showToast('Translation failed: ' + result.error, 'error');
            }
        }
    } catch (error) {
        console.error('Translation error:', error);
        elements.outputText.innerHTML = `<span style="color: var(--accent-red);">Error: ${error.message}</span>`;
        showToast('Translation failed', 'error');
    } finally {
        setLoading(false);
    }
}


async function performOCR() {
    if (!ocrImageData) return;

    const lang = elements.ocrLang.value;

    elements.ocrProgress.classList.remove('hidden');
    elements.startOcrBtn.disabled = true;

    try {
        const result = await Tesseract.recognize(ocrImageData, lang, {
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    const progress = Math.round(m.progress * 100);
                    elements.ocrProgressFill.style.width = `${progress}%`;
                    elements.ocrProgressText.textContent = `Recognizing... ${progress}%`;
                } else {
                    elements.ocrProgressText.textContent = m.status;
                }
            }
        });

        const extractedText = result.data.text.trim();
        if (extractedText) {
            elements.inputText.value = extractedText;
            elements.inputCharCount.textContent = extractedText.length;
            showToast('Text extracted successfully! ✓', 'success');
            closeOcrModal();
        } else {
            showToast('No text found in image', 'error');
        }
    } catch (error) {
        console.error('OCR error:', error);
        showToast('OCR failed: ' + error.message, 'error');
    } finally {
        elements.ocrProgress.classList.add('hidden');
        elements.ocrProgressFill.style.width = '0%';
        elements.startOcrBtn.disabled = false;
    }
}

function closeOcrModal() {
    elements.ocrModal.classList.add('hidden');
    elements.ocrPreview.classList.add('hidden');
    elements.ocrProgress.classList.add('hidden');
    elements.startOcrBtn.disabled = true;
    ocrImageData = null;
}

function setLoading(loading) {
    elements.translateBtn.disabled = loading;
    elements.translateBtn.querySelector('.btn-text').classList.toggle('hidden', loading);
    elements.translateBtn.querySelector('.btn-loader').classList.toggle('hidden', !loading);
}

function updateClipboardStatus(active) {
    const dot = elements.clipboardStatus.querySelector('.indicator-dot');
    dot.classList.toggle('active', active);
    elements.clipboardStatus.querySelector('span:last-child').textContent =
        active ? 'Clipboard active' : 'Clipboard off';
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// Initialize app
init();

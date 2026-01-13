const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, screen, dialog, net } = require('electron');
const path = require('path');
const Store = require('electron-store');
const https = require('https');

// Translation module - using dynamic import for ESM (fallback only)
let googleTranslate = null;
(async () => {
    try {
        const module = await import('@vitalets/google-translate-api');
        googleTranslate = module.translate;
        console.log('Google Translate module loaded (fallback)');
    } catch (error) {
        console.error('Failed to load Google Translate module:', error);
    }
})();

// Translation cache to avoid repeated API calls
const translationCache = new Map();
const MAX_CACHE_SIZE = 1000;

// Multi-service translation configuration
const TRANSLATION_SERVICES = {
    // Lingva Translate - Open source Google Translate frontend (most reliable)
    lingva: {
        name: 'Lingva',
        instances: [
            'https://lingva.ml',
            'https://translate.plausibility.cloud',
            'https://lingva.garuber.dev'
        ],
        currentInstance: 0
    },
    // MyMemory - Free tier: 1000 words/day without API key
    myMemory: {
        name: 'MyMemory',
        url: 'https://api.mymemory.translated.net/get'
    }
};

// Enhanced rate limiting with exponential backoff
const RATE_LIMIT = {
    minDelay: 1000,              // Increased from 500ms to 1000ms
    maxDelay: 3000,              // Increased from 1500ms to 3000ms
    retryDelay: 5000,            // Increased from 3000ms to 5000ms
    maxRetries: 2,
    lastRequest: 0,
    consecutiveErrors: 0,
    cooldownUntil: 0,            // Timestamp when cooldown ends
    cooldownDuration: 60000      // 1 minute cooldown after rate limit
};

// Translation request queue to prevent concurrent requests
const translationQueue = [];
let isProcessingQueue = false;

// Helper function for random delay
function getRandomDelay() {
    return Math.floor(Math.random() * (RATE_LIMIT.maxDelay - RATE_LIMIT.minDelay)) + RATE_LIMIT.minDelay;
}

// Helper function to wait
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to check if we're in cooldown period
function isInCooldown() {
    return Date.now() < RATE_LIMIT.cooldownUntil;
}

// Helper function to enforce rate limiting with exponential backoff
async function enforceRateLimit() {
    // Check if in cooldown period
    if (isInCooldown()) {
        const remainingCooldown = Math.ceil((RATE_LIMIT.cooldownUntil - Date.now()) / 1000);
        throw new Error(`Rate limit cooldown active. Please wait ${remainingCooldown} seconds.`);
    }

    const now = Date.now();
    const timeSinceLastRequest = now - RATE_LIMIT.lastRequest;
    
    // Calculate delay with exponential backoff if there are consecutive errors
    let delay = getRandomDelay();
    if (RATE_LIMIT.consecutiveErrors > 0) {
        // Exponential backoff: multiply delay by 2^consecutiveErrors
        delay = Math.min(delay * Math.pow(2, RATE_LIMIT.consecutiveErrors), 10000);
    }
    
    if (timeSinceLastRequest < delay) {
        const waitTime = delay - timeSinceLastRequest;
        console.log(`Rate limiting: waiting ${waitTime}ms before next request`);
        await wait(waitTime);
    }
    
    RATE_LIMIT.lastRequest = Date.now();
}

// HTTP request helper using Node's https
function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
                ...options.headers
            },
            timeout: 10000
        };

        const req = https.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// Lingva Translate (Google Translate frontend - no rate limits)
async function translateWithLingva(text, from, to) {
    await enforceRateLimit(); // Apply rate limiting even for Lingva
    
    const service = TRANSLATION_SERVICES.lingva;
    let lastError = null;

    // Map language codes
    const sourceLang = from === 'auto' ? 'auto' : from;
    const targetLang = to === 'zh-CN' ? 'zh' : to;

    // Try each instance
    for (let i = 0; i < service.instances.length; i++) {
        const instanceIndex = (service.currentInstance + i) % service.instances.length;
        const baseUrl = service.instances[instanceIndex];

        try {
            // Lingva uses GET with URL path: /api/v1/{source}/{target}/{text}
            const encodedText = encodeURIComponent(text);
            const url = `${baseUrl}/api/v1/${sourceLang}/${targetLang}/${encodedText}`;

            const response = await httpRequest(url);

            if (response.status === 200 && response.data.translation) {
                service.currentInstance = instanceIndex;
                RATE_LIMIT.consecutiveErrors = 0; // Reset error counter on success
                return {
                    success: true,
                    text: response.data.translation,
                    service: 'Lingva',
                    detectedLang: response.data.info?.detectedSource || null
                };
            }
        } catch (error) {
            lastError = error;
            console.log(`Lingva instance ${instanceIndex} failed:`, error.message);
        }
    }

    throw lastError || new Error('All Lingva instances failed');
}

// MyMemory translation (detects language if same source/target)
async function translateWithMyMemory(text, from, to) {
    await enforceRateLimit(); // Apply rate limiting
    
    // MyMemory needs explicit source language, can't use same source and target
    let sourceLang = from;

    // If auto-detect or same language, try to detect first
    if (from === 'auto' || from === to) {
        // Assume Russian or Chinese for auto-detect based on character detection
        if (/[\u4e00-\u9fff]/.test(text)) {
            sourceLang = 'zh-CN';
        } else if (/[\u0400-\u04FF]/.test(text)) {
            sourceLang = 'ru';
        } else {
            sourceLang = 'en'; // Default fallback
        }
    }

    // Skip if source equals target
    if (sourceLang === to) {
        return { success: true, text: text, service: 'MyMemory (same language)' };
    }

    const langPair = `${sourceLang}|${to}`;
    const url = `${TRANSLATION_SERVICES.myMemory.url}?q=${encodeURIComponent(text)}&langpair=${langPair}`;

    const response = await httpRequest(url);

    if (response.status === 200 && response.data.responseStatus === 200) {
        RATE_LIMIT.consecutiveErrors = 0; // Reset error counter on success
        return {
            success: true,
            text: response.data.responseData.translatedText,
            service: 'MyMemory'
        };
    }

    throw new Error(response.data.responseDetails || 'MyMemory translation failed');
}

// Google Translate (fallback with enhanced rate limiting)
async function translateWithGoogle(text, from, to) {
    if (!googleTranslate) {
        throw new Error('Google Translate not available');
    }

    await enforceRateLimit(); // Apply rate limiting
    
    const options = { to };
    if (from && from !== 'auto') {
        options.from = from;
    }

    try {
        const result = await googleTranslate(text, options);
        RATE_LIMIT.consecutiveErrors = 0; // Reset error counter on success
        return {
            success: true,
            text: result.text,
            service: 'Google',
            detectedLang: result.raw?.src || null
        };
    } catch (error) {
        // Check if it's a rate limit error
        if (error.message && (error.message.includes('Too Many Requests') || 
                             error.message.includes('429') ||
                             error.message.includes('rate limit'))) {
            RATE_LIMIT.consecutiveErrors++;
            RATE_LIMIT.cooldownUntil = Date.now() + RATE_LIMIT.cooldownDuration;
            console.log(`Rate limit detected. Entering cooldown for ${RATE_LIMIT.cooldownDuration/1000} seconds`);
        }
        throw error;
    }
}

// Main translation function with fallback chain and improved error handling
async function translateText(text, from, to) {
    const services = [
        { name: 'Lingva', fn: translateWithLingva },
        { name: 'MyMemory', fn: translateWithMyMemory },
        { name: 'Google', fn: translateWithGoogle }
    ];

    let lastError = null;

    for (const service of services) {
        try {
            console.log(`Trying ${service.name}...`);
            const result = await service.fn(text, from, to);
            console.log(`${service.name} succeeded`);
            return result;
        } catch (error) {
            console.log(`${service.name} failed:`, error.message);
            lastError = error;
            
            // Longer delay if rate limit error detected
            const isRateLimitError = error.message && (
                error.message.includes('Too Many Requests') || 
                error.message.includes('429') ||
                error.message.includes('rate limit') ||
                error.message.includes('cooldown')
            );
            
            if (isRateLimitError) {
                RATE_LIMIT.consecutiveErrors++;
                await wait(RATE_LIMIT.retryDelay);
            } else {
                await wait(500); // Normal delay before trying next service
            }
        }
    }

    throw lastError || new Error('All translation services failed');
}

// Initialize store for settings persistence
const store = new Store({
    defaults: {
        targetLanguage: 'ru',
        alwaysOnTop: true,
        clipboardMonitoring: true,
        opacity: 0.95,
        position: { x: null, y: null },
        theme: 'dark'
    }
});

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isQuitting = false;
let lastClipboardText = '';

// For screen capture
const screenshot = require('screenshot-desktop');



// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    const windowWidth = 420;
    const windowHeight = 600;

    // Get saved position, but validate it's on screen
    const savedPosition = store.get('position') || {};
    let startX = savedPosition.x;
    let startY = savedPosition.y;

    // If no saved position or position is off-screen, center the window
    if (startX === null || startX === undefined || startX < 0 || startX > screenWidth - 100) {
        startX = Math.floor((screenWidth - windowWidth) / 2);
    }
    if (startY === null || startY === undefined || startY < 0 || startY > screenHeight - 100) {
        startY = Math.floor((screenHeight - windowHeight) / 2);
    }

    mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x: startX,
        y: startY,
        frame: false,
        transparent: false, // Changed to false for better compatibility
        resizable: true,
        alwaysOnTop: store.get('alwaysOnTop') || false,
        skipTaskbar: false,
        backgroundColor: '#0d1117',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        icon: path.join(__dirname, '../../assets/icon.png'),
        show: true
    });

    console.log('Window created, loading file...');
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('Failed to load:', errorCode, errorDescription);
    });

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Page loaded successfully');
    });

    // Ensure window is visible and focused when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.setOpacity(store.get('opacity') || 0.95);
    });

    // Show window when clicked in taskbar
    mainWindow.on('show', () => {
        mainWindow.focus();
    });

    // Save position on move
    mainWindow.on('moved', () => {
        const [x, y] = mainWindow.getPosition();
        store.set('position', { x, y });
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });

    // Start clipboard monitoring
    if (store.get('clipboardMonitoring')) {
        startClipboardMonitoring();
    }
}

function startClipboardMonitoring() {
    setInterval(() => {
        const currentText = clipboard.readText();
        if (currentText && currentText !== lastClipboardText && currentText.trim().length > 0) {
            lastClipboardText = currentText;
            if (mainWindow && store.get('clipboardMonitoring')) {
                mainWindow.webContents.send('clipboard-changed', currentText);
            }
        }
    }, 500);
}

function createChatImportWindow() {
    if (overlayWindow) {
        overlayWindow.show();
        overlayWindow.focus();
        return;
    }

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    overlayWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        x: Math.floor((screenWidth - 1000) / 2),
        y: Math.floor((screenHeight - 700) / 2),
        frame: false,
        transparent: false,
        resizable: true,
        alwaysOnTop: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    overlayWindow.loadFile(path.join(__dirname, '../renderer/chat-import.html'));

    overlayWindow.on('closed', () => {
        overlayWindow = null;
    });
}


function createTray() {
    // Create a simple tray icon
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');

    // Create a default icon if file doesn't exist
    let trayIcon;
    try {
        trayIcon = nativeImage.createFromPath(iconPath);
        if (trayIcon.isEmpty()) {
            trayIcon = createDefaultTrayIcon();
        }
    } catch (e) {
        trayIcon = createDefaultTrayIcon();
    }

    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show TelBot Translate',
            click: () => {
                mainWindow.show();
                mainWindow.focus();
            }
        },
        {
            label: 'Toggle Always on Top',
            type: 'checkbox',
            checked: store.get('alwaysOnTop'),
            click: (menuItem) => {
                store.set('alwaysOnTop', menuItem.checked);
                mainWindow.setAlwaysOnTop(menuItem.checked);
            }
        },
        {
            label: 'Clipboard Monitoring',
            type: 'checkbox',
            checked: store.get('clipboardMonitoring'),
            click: (menuItem) => {
                store.set('clipboardMonitoring', menuItem.checked);
                mainWindow.webContents.send('setting-changed', { key: 'clipboardMonitoring', value: menuItem.checked });
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('TelBot Translate');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function createDefaultTrayIcon() {
    // Create a simple colored icon programmatically
    const size = 32;
    const canvas = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            // Create a gradient from cyan to purple
            canvas[idx] = 100;     // R
            canvas[idx + 1] = 200; // G  
            canvas[idx + 2] = 255; // B
            canvas[idx + 3] = 255; // A
        }
    }

    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function registerGlobalShortcuts() {
    // Toggle window visibility
    globalShortcut.register('CommandOrControl+Shift+T', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Quick translate clipboard to English
    globalShortcut.register('CommandOrControl+Shift+R', () => {
        const text = clipboard.readText();
        if (text) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('quick-translate', { text, mode: 'read' });
        }
    });

    // Quick translate to target language
    globalShortcut.register('CommandOrControl+Shift+W', () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('quick-translate', { text: '', mode: 'write' });
    });

    // OCR from screenshot
    globalShortcut.register('CommandOrControl+Shift+O', () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('trigger-ocr');
    });
}

// IPC Handlers
ipcMain.handle('get-settings', () => {
    return store.store;
});

ipcMain.handle('set-setting', (event, { key, value }) => {
    store.set(key, value);

    if (key === 'alwaysOnTop') {
        mainWindow.setAlwaysOnTop(value);
    } else if (key === 'opacity') {
        mainWindow.setOpacity(value);
    }

    return true;
});

ipcMain.handle('get-clipboard', () => {
    return clipboard.readText();
});

ipcMain.handle('set-clipboard', (event, text) => {
    clipboard.writeText(text);
    return true;
});

ipcMain.handle('get-clipboard-image', () => {
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
        return image.toDataURL();
    }
    return null;
});

ipcMain.on('minimize-window', () => {
    mainWindow.minimize();
});

ipcMain.on('close-window', () => {
    mainWindow.hide();
});

// Queue processor for translation requests
async function processTranslationQueue() {
    if (isProcessingQueue || translationQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;

    while (translationQueue.length > 0) {
        const { text, from, to, resolve, reject } = translationQueue.shift();

        try {
            const result = await translateTextWithCache(text, from, to);
            resolve(result);
        } catch (error) {
            reject(error);
        }

        // Small delay between queue items
        await wait(200);
    }

    isProcessingQueue = false;
}

// Translation with caching
async function translateTextWithCache(text, from, to) {
    // Trim and check for empty text
    const trimmedText = text?.trim();
    if (!trimmedText) {
        throw new Error('Empty text');
    }

    // Check cache first
    const cacheKey = `${from || 'auto'}_${to}_${trimmedText.substring(0, 100)}`;
    if (translationCache.has(cacheKey)) {
        console.log('Cache hit for translation');
        return translationCache.get(cacheKey);
    }

    // Use multi-service translation
    const result = await translateText(trimmedText, from || 'auto', to);

    const response = {
        success: true,
        text: result.text,
        service: result.service,
        detectedLang: result.detectedLang || null
    };

    // Cache the successful result
    if (translationCache.size >= MAX_CACHE_SIZE) {
        const firstKey = translationCache.keys().next().value;
        translationCache.delete(firstKey);
    }
    translationCache.set(cacheKey, response);

    return response;
}

// Translation handler with queue management
ipcMain.handle('translate-text', async (event, { text, from, to }) => {
    // Trim and check for empty text
    const trimmedText = text?.trim();
    if (!trimmedText) {
        return { success: false, error: 'Empty text' };
    }

    // Check cache first for quick response
    const cacheKey = `${from || 'auto'}_${to}_${trimmedText.substring(0, 100)}`;
    if (translationCache.has(cacheKey)) {
        console.log('Cache hit for translation');
        return translationCache.get(cacheKey);
    }

    // Add to queue and process
    return new Promise((resolve, reject) => {
        translationQueue.push({
            text: trimmedText,
            from: from || 'auto',
            to,
            resolve: (result) => resolve(result),
            reject: (error) => resolve({ 
                success: false, 
                error: error.message || 'Translation failed'
            })
        });

        // Start processing queue
        processTranslationQueue().catch(err => {
            console.error('Queue processing error:', err);
        });
    });
});

ipcMain.handle('select-image-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }
        ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Chat Import window handlers
ipcMain.on('open-overlay', () => {
    createChatImportWindow();
});

ipcMain.on('open-chat-import', () => {
    createChatImportWindow();
});

ipcMain.on('close-overlay', () => {
    if (overlayWindow) {
        overlayWindow.close();
    }
});

ipcMain.on('close-chat-import', () => {
    if (overlayWindow) {
        overlayWindow.close();
    }
});

ipcMain.on('show-main-window', () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    }
});

ipcMain.on('toggle-overlay-pin', (event, isPinned) => {
    if (overlayWindow) {
        overlayWindow.setAlwaysOnTop(isPinned);
    }
});

ipcMain.on('set-overlay-opacity', (event, opacity) => {
    if (overlayWindow) {
        overlayWindow.setOpacity(opacity);
    }
});

// Capture screen and translate using OCR
const Tesseract = require('tesseract.js');

ipcMain.handle('capture-and-translate', async (event, { targetLang, region }) => {
    try {
        // Capture screenshot
        const imgBuffer = await screenshot({ format: 'png' });
        const base64Image = `data:image/png;base64,${imgBuffer.toString('base64')}`;

        // Perform OCR - detect Russian, Chinese, and English
        const ocrResult = await Tesseract.recognize(base64Image, 'rus+chi_sim+eng', {
            logger: m => console.log('OCR:', m.status)
        });

        const extractedText = ocrResult.data.text.trim();

        if (!extractedText) {
            return { success: false, error: 'No text found in screenshot' };
        }

        // Translate the text
        if (!translate) {
            return { success: true, originalText: extractedText, translatedText: '[Translation module loading...]' };
        }

        const translationResult = await translate(extractedText, { to: targetLang });

        return {
            success: true,
            originalText: extractedText,
            translatedText: translationResult.text
        };
    } catch (error) {
        console.error('Capture and translate error:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('select-screen-region', async () => {
    // Region selection - return null for now (full screen capture)
    return null;
});

// App lifecycle
app.whenReady().then(() => {
    createWindow();
    createTray();
    registerGlobalShortcuts();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

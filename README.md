# 🌐 TelBot Translate

A powerful desktop translation application built with Electron, designed for seamless multilingual communication - perfect for Telegram users and content creators!

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Electron](https://img.shields.io/badge/Electron-28.x-47848F.svg)

## Features

- 🔄 **Multi-Service Translation**: Uses 3 different translation services with automatic fallback
  - Lingva Translate (Primary)
  - MyMemory Translation (Backup)
  - Google Translate (Fallback)
- 📖 **Dual Mode Operation**: Read mode (translate to English) & Write mode (translate from English)
- 🚀 **Advanced Rate Limiting Protection**: Never get IP blocked with smart request queuing
- 💾 **Smart Caching**: Instant translations for repeated text
- 📋 **Clipboard Monitoring**: Auto-translate copied text
- 🔍 **OCR Support**: Extract and translate text from images using Tesseract.js
- 🎨 **Beautiful Dark UI**: Modern, cyberpunk-inspired interface
- ⌨️ **Global Hotkeys**: Quick access from anywhere
- 📁 **Chat Import**: Import and translate Telegram chat exports

## 🎯 Perfect For

- 🔐 Threat Intelligence Researchers
- 💬 Telegram Group Admins
- 🌍 Multilingual Content Creators
- 📰 International News Readers
- 🎮 Gaming Communities
- 📚 Language Learners
- 🎯 **System Tray**: Always accessible, minimal footprint
- 🌍 **20+ Languages**: Russian, Chinese, Ukrainian, Korean, Japanese, Arabic, and more
- 🎨 **Premium Dark UI**: Beautiful, modern interface

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+T` | Toggle window visibility |
| `Ctrl+Shift+R` | Quick translate clipboard to English |
| `Ctrl+Shift+W` | Activate Write mode |
| `Ctrl+Shift+O` | Open OCR dialog |
| `Ctrl+Enter` | Translate (when window focused) |

## Installation

```bash
# Install dependencies
npm install

# Run the application
npm start

# Build for Windows
npm run build
```

## Usage

### Read Mode (Incoming Messages)
1. Copy text from Telegram/Discord/Forum
2. TelBot automatically detects the text
3. Click Translate or press `Ctrl+Shift+R`
4. Get English translation instantly

### Write Mode (Outgoing Messages)
1. Switch to Write mode
2. Type your message in English
3. Select target language (Russian, Chinese, etc.)
4. Click Translate
5. Copy the translated text and paste into chat

### OCR Mode
1. Take a screenshot of foreign text
2. Press `Ctrl+Shift+O` or click the camera icon
3. Paste from clipboard or select image file
4. Extract and translate text

## Tech Stack

- **Electron**: Cross-platform desktop framework
- **Google Translate API**: Reliable translation engine
- **Tesseract.js**: OCR for image text extraction
- **Electron Store**: Persistent settings

## License

MIT

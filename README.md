# FluxDrop 

<div align="center">
  <img src="fluxdrop-web/public/og-image.png" alt="FluxDrop Banner" width="100%">
  <br />
  <p align="center">
    <b>Instant, private, cross-device file sharing through your browser.</b>
    <br />
    <i>Powered by WebRTC, Next.js, and End-to-End Encryption.</i>
  </p>
  
  <p align="center">
    <img src="https://img.shields.io/badge/Next.js-14-black?style=for-the-badge&logo=next.js" alt="Next.js">
    <img src="https://img.shields.io/badge/TypeScript-informational?style=for-the-badge&logo=typescript" alt="TypeScript">
    <img src="https://img.shields.io/badge/WebRTC-P2P-orange?style=for-the-badge" alt="WebRTC">
    <img src="https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css" alt="Tailwind">
  </p>
</div>

---

## 🚀 What is FluxDrop?
**FluxDrop** is a browser-based, peer-to-peer file transfer system. No accounts, no installation, no storage—just instant, encrypted transfers between any devices. It uses **WebRTC** for direct data channels and **ECDH Key Exchange** to ensure only you and the receiver can access the files.

---

## ✨ Key Features
- ⚡ **Zero Setup:** No accounts or apps needed. Just open the browser and share.
- 🔒 **Maximum Privacy:** End-to-end encrypted. No file data ever touches our server.
- 🚀 **LAN Speed:** Direct P2P transfers mean data moves as fast as your network allows.
- 📱 **Universal:** Works on any modern browser across mobile, tablet, and desktop.
- 🔗 **Easy Pairing:** Use 6-digit codes, QR codes, or direct links to connect peers.

---

## 🛠 Technical Stack
| Frontend | Backend (Signaling) | Infrastructure |
| :--- | :--- | :--- |
| **Next.js 14** (App Router) | **Node.js 20** (TypeScript) | **Vercel** (Frontend) |
| **Tailwind CSS** | **ws** (WebSocket) | **Railway** (Backend) |
| **Zustand** (State Management) | **Upstash Redis** (Session) | **Metered.ca** (TURN/STUN) |
| **WebCrypto API** (AES-GCM) | **Zod** (Validation) | |

---

## 📁 Project Structure
- [**`fluxdrop-web/`**](./fluxdrop-web): The Next.js client interface.
- [**`fluxdrop-server/`**](./fluxdrop-server): The Node.js signaling server for peer discovery.

---

## 🚀 Quick Start (Development)

### 1. Clone the repository
```bash
git clone https://github.com/Premshaw23/fluxdrop.git
cd fluxdrop
```

### 2. Setup Signaling Server
```bash
cd fluxdrop-server
npm install
npm run dev
```

### 3. Setup Web Frontend
```bash
cd ../fluxdrop-web
npm install
npm run dev
# Open http://localhost:3000
```

---

## 📖 Documentation
For more detailed technical information, check the sub-folder documentation:

- 🏗️ **Core Logic**: [Architecture & Protocol](./fluxdrop-web/ARCHITECTURE.md)
- 🔐 **Security**: [Security Model](./fluxdrop-web/SECURITY.md)
- 📡 **Signaling**: [Redis Integration](./fluxdrop-server/REDIS.md)
- 🔌 **API**: [WebSocket Protocol](./fluxdrop-web/API.md)

---

## 🚀 Deployment Guide
- **Frontend**: Deploy `fluxdrop-web` to **Vercel**.
- **Backend**: Deploy `fluxdrop-server` to **Railway**.
- **Redis**: Use **Upstash Redis** for ephemeral session storage.
- **TURN**: Configure **Metered.ca** for network traversal (Symmetric NAT handles).

---

## ⚠️ Known Limitations
- **Safari Support**: Folder uploads are limited due to WebKit restrictions.
- **File Size**: Most browsers have a ~2GB memory limit for blob handling.
- **Persistence**: No transfer history is saved to ensure maximum privacy.

---

<div align="center">
  <b>Philosophy:</b> <i>"Be the best at one thing—instant, private file transfer."</i>
</div>


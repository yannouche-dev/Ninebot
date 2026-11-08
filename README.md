# Ninebot E3 Pro Controller

Minimal Android BLE diagnostic app for the Ninebot E3 Pro 3.

GitHub Actions builds a debug APK on pushes to main and manual workflow runs. The artifact is named ninebot-e3-pro-debug.

The app scans BLE devices, connects to a selected device, and lists GATT services/characteristics. The Sport write control is deliberately disabled until the exact E3 Pro 3 protocol is verified; it does not send undocumented commands or bypass firmware safety limits.

Local requirements: JDK 17, Android SDK 35, Gradle 8.9.

Build refresh: direct APK handoff.

## Studio vidéo IA (GitHub Pages + Actions)

Ce dépôt contient aussi un générateur de vidéos IA gratuit : une page GitHub Pages
déclenche un workflow GitHub Actions qui génère la vidéo (GPU gratuit Hugging Face
ZeroGPU avec LTX-2.5/LTX-2.3, repli CPU AnimateDiff-Lightning) et la publie dans
une galerie. Voir [ai-video/README.md](ai-video/README.md).

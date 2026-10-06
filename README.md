# Ninebot E3 Pro Controller

Minimal Android BLE diagnostic app for the Ninebot E3 Pro 3.

GitHub Actions builds a debug APK on pushes to main and manual workflow runs. The artifact is named ninebot-e3-pro-debug.

The app scans BLE devices, connects to a selected device, and lists GATT services/characteristics. The Sport write control is deliberately disabled until the exact E3 Pro 3 protocol is verified; it does not send undocumented commands or bypass firmware safety limits.

Local requirements: JDK 17, Android SDK 35, Gradle 8.9.

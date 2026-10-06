package com.example.ninebote3

import android.Manifest
import android.app.Activity
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.*
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.UUID

class MainActivity : Activity() {
    companion object {
        private const val PERMISSION_REQUEST = 10
        private const val SCAN_DURATION_MS = 10_000L
        private const val RETRY_DEBOUNCE_MS = 2_000L

        private val UUID_NUS_SERVICE: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_RX: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_TX: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private val UUID_GAP_SERVICE: UUID = UUID.fromString("00001800-0000-1000-8000-00805f9b34fb")
        private val UUID_DEVICE_NAME: UUID = UUID.fromString("00002a00-0000-1000-8000-00805f9b34fb")
        private val UUID_DEVICE_INFO: UUID = UUID.fromString("0000180a-0000-1000-8000-00805f9b34fb")
        private val UUID_PNP_ID: UUID = UUID.fromString("00002a50-0000-1000-8000-00805f9b34fb")
    }

    private lateinit var statusView: TextView
    private lateinit var logView: TextView
    private lateinit var logBody: ScrollView
    private lateinit var logToggle: Button
    private lateinit var deviceList: LinearLayout
    private lateinit var deviceScroll: ScrollView
    private lateinit var scanButton: Button

    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var gatt: BluetoothGatt? = null
    private val handler = Handler(Looper.getMainLooper())
    private val found = linkedMapOf<String, BluetoothDevice>()
    private val trace = StringBuilder()
    private val readQueue = ArrayDeque<BluetoothGattCharacteristic>()

    private val retryScan = Runnable {
        appendLog("Retry debounce elapsed; starting scan.")
        startScan()
    }

    private val stopScanAfterTimeout = Runnable {
        if (scanning) {
            stopScan("Scan timeout.")
            if (found.isEmpty()) scheduleRetry("No BLE devices found.")
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        buildUi()
        appendLog("App opened.")
        setStatus("Starting…")
        ensurePermissionsAndAutoScan()
    }

    private fun buildUi() {
        val page = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = true
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(16))
        }
        page.addView(
            root,
            android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )

        root.addView(TextView(this).apply {
            text = "Ninebot E3 Pro Controller"
            textSize = 24f
        })

        statusView = TextView(this).apply {
            text = "Starting…"
            textSize = 14f
            setPadding(0, dp(4), 0, dp(10))
        }
        root.addView(statusView)

        scanButton = Button(this).apply {
            text = "SCAN NOW"
            setOnClickListener {
                handler.removeCallbacks(retryScan)
                if (scanning) stopScan("Scan stopped by user.") else startScan()
            }
        }
        root.addView(scanButton)

        root.addView(TextView(this).apply {
            text = "SEARCH RESULTS"
            textSize = 13f
            setPadding(0, dp(10), 0, dp(4))
        })

        deviceList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(4))
        }
        deviceScroll = ScrollView(this).apply {
            isVerticalScrollBarEnabled = true
            isNestedScrollingEnabled = true
            addView(deviceList)
        }
        root.addView(
            deviceScroll,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(220)
            )
        )

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10), 0, 0)
        }
        row.addView(EditText(this).apply {
            hint = "25"
            setText("25")
            inputType = 2
            layoutParams = LinearLayout.LayoutParams(0, dp(56), 1f)
        })
        row.addView(TextView(this).apply {
            text = " km/h"
            textSize = 18f
        })
        row.addView(Button(this).apply {
            text = "SET SPORT"
            isEnabled = false
            setOnClickListener { toast("Disabled until the application protocol is verified.") }
        })
        root.addView(row)

        root.addView(TextView(this).apply {
            text = "Passive diagnostics only: notifications and safe identification reads. No scooter command payloads are sent."
            setPadding(0, dp(6), 0, dp(8))
        })

        val logActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }

        logToggle = Button(this).apply {
            text = "TRACE LOG ▶"
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { toggleLog() }
        }
        logActions.addView(logToggle)

        logActions.addView(Button(this).apply {
            text = "COPY TRACE"
            setOnClickListener { copyTrace() }
        })
        root.addView(logActions)

        logView = TextView(this).apply {
            textSize = 12f
            setTextIsSelectable(true)
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        logBody = ScrollView(this).apply {
            visibility = View.GONE
            isVerticalScrollBarEnabled = true
            isNestedScrollingEnabled = true
            addView(logView)
        }
        root.addView(
            logBody,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(300)
            )
        )

        setContentView(page)
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private fun setStatus(text: String) {
        runOnUiThread { statusView.text = text }
    }

    private fun toggleLog() {
        val open = logBody.visibility != View.VISIBLE
        logBody.visibility = if (open) View.VISIBLE else View.GONE
        logToggle.text = if (open) "TRACE LOG ▼" else "TRACE LOG ▶"
    }

    private fun copyTrace() {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Ninebot BLE trace", trace.toString()))
        toast("Trace copied")
    }

    private fun ensurePermissionsAndAutoScan() {
        if (Build.VERSION.SDK_INT >= 31) {
            val scanGranted = checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
            val connectGranted = checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            if (!scanGranted || !connectGranted) {
                appendLog("Requesting Bluetooth permissions.")
                requestPermissions(
                    arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT),
                    PERMISSION_REQUEST
                )
                return
            }
        }
        appendLog("Bluetooth permissions ready; automatic scan.")
        startScan()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != PERMISSION_REQUEST) return

        if (results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED }) {
            appendLog("Bluetooth permissions granted.")
            startScan()
        } else {
            setStatus("Bluetooth permission required")
            appendLog("Bluetooth permission denied; automatic scan unavailable.")
            toast("Bluetooth permission is required to scan.")
        }
    }

    private fun startScan() {
        handler.removeCallbacks(retryScan)
        handler.removeCallbacks(stopScanAfterTimeout)

        if (Build.VERSION.SDK_INT >= 31 &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
            appendLog("Scan blocked: BLUETOOTH_SCAN permission missing.")
            ensurePermissionsAndAutoScan()
            return
        }

        val adapter = (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (!adapter.isEnabled) {
            setStatus("Bluetooth disabled")
            appendLog("Scan failed: Bluetooth is disabled.")
            toast("Enable Bluetooth first")
            scheduleRetry("Bluetooth disabled.")
            return
        }

        if (scanning) return

        found.clear()
        deviceList.removeAllViews()
        scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            setStatus("BLE scanner unavailable")
            appendLog("Scan failed: Bluetooth LE scanner unavailable.")
            scheduleRetry("BLE scanner unavailable.")
            return
        }

        scanning = true
        scanButton.text = "STOP SCAN"
        setStatus("Scanning…")
        appendLog("BLE scan started.")
        scanner?.startScan(scanCallback)
        handler.postDelayed(stopScanAfterTimeout, SCAN_DURATION_MS)
    }

    private fun stopScan(reason: String) {
        handler.removeCallbacks(stopScanAfterTimeout)
        if (scanning) {
            scanner?.stopScan(scanCallback)
            scanning = false
            scanButton.text = "SCAN NOW"
        }
        appendLog(reason)
    }

    private fun scheduleRetry(reason: String) {
        handler.removeCallbacks(retryScan)
        appendLog(reason + " Retry scheduled in " + RETRY_DEBOUNCE_MS + " ms.")
        handler.postDelayed(retryScan, RETRY_DEBOUNCE_MS)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) {
            runOnUiThread {
                val device = result.device
                if (!found.containsKey(device.address)) {
                    found[device.address] = device
                    val name = device.name ?: "Unknown BLE device"
                    appendLog("Found: " + name + " / " + device.address + " / RSSI " + result.rssi)
                    deviceList.addView(Button(this@MainActivity).apply {
                        text = name + "\n" + device.address + " (" + result.rssi + " dBm)"
                        setOnClickListener { connect(device) }
                    })
                }
            }
        }

        override fun onScanFailed(code: Int) {
            runOnUiThread {
                scanning = false
                scanButton.text = "SCAN NOW"
                setStatus("Scan failed")
                appendLog("BLE scan failed with code " + code + ".")
                scheduleRetry("Scan failure.")
            }
        }
    }

    private fun connect(device: BluetoothDevice) {
        handler.removeCallbacks(retryScan)
        stopScan("Device selected; scan stopped.")
        readQueue.clear()
        gatt?.close()
        setStatus("Connecting to " + (device.name ?: device.address))
        appendLog("Connecting to " + device.address + "…")
        gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS && state == BluetoothProfile.STATE_CONNECTED) {
                setStatus("Connected · discovering services")
                appendLogUi("Connected. Discovering GATT services.")
                g.discoverServices()
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                appendLogUi("Disconnected. GATT status=" + status + ".")
                setStatus("Disconnected")
                g.close()
                if (gatt === g) gatt = null
                runOnUiThread { scheduleRetry("Connection lost or failed.") }
            } else {
                appendLogUi("GATT state=" + state + ", status=" + status + ".")
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                appendLogUi("Service discovery failed: " + status + ".")
                setStatus("Service discovery failed")
                g.disconnect()
                return
            }

            val out = StringBuilder("GATT services discovered:")
            for (service in g.services) {
                out.append("\nSERVICE ").append(service.uuid)
                for (c in service.characteristics) {
                    out.append("\n  ").append(c.uuid)
                        .append(" props=").append(c.properties)
                        .append(" [").append(propertyNames(c.properties)).append("]")
                }
            }
            appendLogUi(out.toString())

            val nus = g.getService(UUID_NUS_SERVICE)
            if (nus == null) {
                setStatus("Connected · NUS not found")
                appendLogUi("NUS transport not found on this device.")
                return
            }

            val tx = nus.getCharacteristic(UUID_NUS_TX)
            val rx = nus.getCharacteristic(UUID_NUS_RX)
            appendLogUi(
                "NUS detected. TX notify=" + (tx != null) +
                    ", RX writable=" + (rx != null) +
                    ". No application payload writes will be sent."
            )
            setStatus("Connected · NUS detected · passive capture")

            queueIdentificationReads(g)

            if (tx != null) {
                enableNotifications(g, tx)
            } else {
                appendLogUi("NUS TX characteristic missing; cannot capture notifications.")
                startNextRead(g)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (descriptor.uuid == UUID_CCCD) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    appendLogUi("NUS TX notifications enabled.")
                } else {
                    appendLogUi("Failed to enable NUS TX notifications. status=" + status)
                }
                startNextRead(g)
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            val value = characteristic.value ?: byteArrayOf()
            handleReadResult(g, characteristic, value, status)
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            handleReadResult(g, characteristic, value, status)
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            handleNotification(characteristic, characteristic.value ?: byteArrayOf())
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handleNotification(characteristic, value)
        }
    }

    private fun queueIdentificationReads(g: BluetoothGatt) {
        readQueue.clear()

        g.getService(UUID_GAP_SERVICE)
            ?.getCharacteristic(UUID_DEVICE_NAME)
            ?.takeIf { it.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0 }
            ?.let { readQueue.add(it) }

        g.getService(UUID_DEVICE_INFO)
            ?.getCharacteristic(UUID_PNP_ID)
            ?.takeIf { it.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0 }
            ?.let { readQueue.add(it) }

        appendLogUi("Queued " + readQueue.size + " safe identification read(s).")
    }

    private fun enableNotifications(g: BluetoothGatt, tx: BluetoothGattCharacteristic) {
        val localEnabled = g.setCharacteristicNotification(tx, true)
        appendLogUi("Enable local NUS TX notification routing: " + localEnabled)

        val cccd = tx.getDescriptor(UUID_CCCD)
        if (cccd == null) {
            appendLogUi("NUS TX CCCD missing; notification subscription cannot be completed.")
            startNextRead(g)
            return
        }

        val result = if (Build.VERSION.SDK_INT >= 33) {
            g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        } else {
            @Suppress("DEPRECATION")
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            @Suppress("DEPRECATION")
            if (g.writeDescriptor(cccd)) BluetoothStatusCodes.SUCCESS else BluetoothStatusCodes.ERROR_UNKNOWN
        }

        appendLogUi("CCCD subscription request result=" + result)
        if (result != BluetoothStatusCodes.SUCCESS) {
            startNextRead(g)
        }
    }

    private fun startNextRead(g: BluetoothGatt) {
        val next = readQueue.pollFirst() ?: run {
            appendLogUi("Passive capture ready. Waiting for NUS TX packets.")
            setStatus("Connected · listening")
            return
        }

        appendLogUi("READ request " + shortUuid(next.uuid))
        val result = g.readCharacteristic(next)
        if (!result) {
            appendLogUi("READ could not start for " + shortUuid(next.uuid))
            startNextRead(g)
        }
    }

    private fun handleReadResult(
        g: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int
    ) {
        if (status == BluetoothGatt.GATT_SUCCESS) {
            val label = when (characteristic.uuid) {
                UUID_DEVICE_NAME -> "Device Name"
                UUID_PNP_ID -> "PnP ID"
                else -> shortUuid(characteristic.uuid)
            }
            appendLogUi("READ " + label + " · " + packetSummary(value))

            if (characteristic.uuid == UUID_DEVICE_NAME) {
                val name = value.toString(Charsets.UTF_8).trimEnd('\u0000')
                if (name.isNotBlank()) appendLogUi("IDENT Device Name = " + name)
            } else if (characteristic.uuid == UUID_PNP_ID) {
                parsePnpId(value)?.let { appendLogUi(it) }
            }
        } else {
            appendLogUi("READ failed " + shortUuid(characteristic.uuid) + " status=" + status)
        }
        startNextRead(g)
    }

    private fun handleNotification(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (characteristic.uuid == UUID_NUS_TX) {
            appendLogUi("RX NUS · " + packetSummary(value))
        } else {
            appendLogUi("NOTIFY " + shortUuid(characteristic.uuid) + " · " + packetSummary(value))
        }
    }

    private fun parsePnpId(value: ByteArray): String? {
        if (value.size < 7) return null
        fun u16(offset: Int): Int =
            (value[offset].toInt() and 0xff) or ((value[offset + 1].toInt() and 0xff) shl 8)

        val source = value[0].toInt() and 0xff
        val vendor = u16(1)
        val product = u16(3)
        val version = u16(5)
        return "IDENT PnP ID · source=" + source +
            " vendor=0x" + vendor.toString(16).padStart(4, '0') +
            " product=0x" + product.toString(16).padStart(4, '0') +
            " version=0x" + version.toString(16).padStart(4, '0')
    }

    private fun packetSummary(value: ByteArray): String {
        val hex = value.joinToString(" ") { "%02X".format(it.toInt() and 0xff) }
        val ascii = buildString {
            value.forEach { byte ->
                val c = byte.toInt() and 0xff
                append(if (c in 32..126) c.toChar() else '.')
            }
        }
        return value.size + " B · HEX [" + hex + "] · ASCII [" + ascii + "]"
    }

    private fun propertyNames(properties: Int): String {
        val names = mutableListOf<String>()
        if (properties and BluetoothGattCharacteristic.PROPERTY_READ != 0) names += "READ"
        if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) names += "WRITE"
        if (properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) names += "WRITE_NR"
        if (properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) names += "NOTIFY"
        if (properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) names += "INDICATE"
        return if (names.isEmpty()) "-" else names.joinToString("|")
    }

    private fun shortUuid(uuid: UUID): String {
        val s = uuid.toString()
        return if (s.endsWith("-0000-1000-8000-00805f9b34fb")) s.substring(4, 8).uppercase() else s
    }

    private fun appendLogUi(message: String) {
        runOnUiThread { appendLog(message) }
    }

    private fun appendLog(message: String) {
        val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
        if (trace.isNotEmpty()) trace.append('\n')
        trace.append('[').append(time).append("] ").append(message)
        logView.text = trace.toString()
        logBody.post { logBody.fullScroll(View.FOCUS_DOWN) }
    }

    private fun toast(s: String) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show()
    }

    override fun onDestroy() {
        handler.removeCallbacks(retryScan)
        handler.removeCallbacks(stopScanAfterTimeout)
        if (scanning) scanner?.stopScan(scanCallback)
        readQueue.clear()
        gatt?.close()
        super.onDestroy()
    }
}

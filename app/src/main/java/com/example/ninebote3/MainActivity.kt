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
import android.util.Base64
import android.view.View
import android.widget.*
import com.example.ninebote3.protocol.ProtocolNinebot
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.math.abs

@OptIn(ExperimentalUnsignedTypes::class)
class MainActivity : Activity() {
    companion object {
        private const val PERMISSION_REQUEST = 10
        private const val SCAN_DURATION_MS = 10_000L
        private const val RETRY_DEBOUNCE_MS = 2_000L
        private const val PAIR_RETRY_MS = 1_000L
        private const val REGISTER_TIMEOUT_MS = 2_500L
        private const val INIT_TIMEOUT_MS = 1_800L
        private const val INIT_MAX_ATTEMPTS = 4
        private const val PROTOCOL_PROBE_TIMEOUT_MS = 1_500L
        private const val BUILD_ID = "r7-auto-protocol"

        private val UUID_NUS_SERVICE = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_RX = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_TX = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private const val CLIENT = 0x3D
        private const val BLE = 0x21
        private const val CONTROL = 0x20

        private const val CMD_READ = 0x01
        private const val CMD_WRITE_NO_REPLY = 0x03
        private const val CMD_READ_ACK = 0x04
        private const val CMD_INIT = 0x5B
        private const val CMD_PING = 0x5C
        private const val CMD_PAIR = 0x5D

        private const val REG_RATED_MAX = 0x48
        private const val REG_SPEED_RELEASE = 0x72
        private const val REG_NORMAL_SPEED = 0x73
        private const val REG_LIMITED_SPEED = 0x74
    }

    private enum class AuthState {
        IDLE, INIT_SENT, WAIT_PAIR, PAIR_SENT, AUTHENTICATED, FAILED
    }

    private enum class ProtocolMode {
        UNKNOWN, PROBING_LEGACY, LEGACY_55AA, ENCRYPTED_5AA5
    }

    private lateinit var statusView: TextView
    private lateinit var sportStatusView: TextView
    private lateinit var logView: TextView
    private lateinit var logBody: ScrollView
    private lateinit var logToggle: Button
    private lateinit var deviceList: LinearLayout
    private lateinit var scanButton: Button
    private lateinit var sport25Button: Button
    private lateinit var sport32Button: Button

    private val handler = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("ninebot", MODE_PRIVATE) }
    private val trace = StringBuilder()
    private val found = linkedMapOf<String, BluetoothDevice>()

    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var gatt: BluetoothGatt? = null
    private var nusRx: BluetoothGattCharacteristic? = null
    private var crypto: ProtocolNinebot? = null
    private var authState = AuthState.IDLE
    private var scooterSerial: ByteArray? = null
    private var autoConnectAttempted = false
    private var protocolName = "Ninebot"
    private var initAttempt = 0
    private var useWriteNoResponse = false
    private var protocolMode = ProtocolMode.UNKNOWN

    private val encryptedRxBuffer = ByteArrayOutputStream()
    private val writeChunks = ArrayDeque<ByteArray>()
    private var writeInProgress = false

    private val registerQueue = ArrayDeque<Int>()
    private val registerRaw = linkedMapOf<Int, Int>()
    private var pendingRegister: Int? = null
    private var speedReleaseScale = 1
    private var ratedMaxKmh: Double? = null
    private var pendingTargetKmh: Int? = null

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

    private val pairRetry = object : Runnable {
        override fun run() {
            if (authState == AuthState.WAIT_PAIR) {
                setStatus("Pairing · press scooter power button once if requested")
                sendPairPing()
                handler.postDelayed(this, PAIR_RETRY_MS)
            }
        }
    }

    private val protocolProbeTimeout = Runnable {
        if (protocolMode != ProtocolMode.PROBING_LEGACY) return@Runnable
        appendLog("No 55 AA response; falling back to encrypted 5A A5 protocol.")
        protocolMode = ProtocolMode.ENCRYPTED_5AA5
        useWriteNoResponse = false
        gatt?.let { beginAuthentication(it) }
    }

    private val initTimeout = Runnable {
        if (authState != AuthState.INIT_SENT) return@Runnable

        initAttempt++
        if (initAttempt >= INIT_MAX_ATTEMPTS) {
            authFailure("No INIT response after " + INIT_MAX_ATTEMPTS + " attempts.")
            sportStatusView.text = "No controller response — wake scooter / close other scooter apps"
            return@Runnable
        }

        useWriteNoResponse = !useWriteNoResponse
        setStatus("Wake scooter · retrying authentication…")
        appendLog(
            "AUTH INIT timeout. Retry " + (initAttempt + 1) + "/" + INIT_MAX_ATTEMPTS +
                " using " + if (useWriteNoResponse) "WRITE_NO_RESPONSE" else "WRITE_REQUEST"
        )
        toast("Wake the scooter with one short power-button press")
        handler.postDelayed({ attemptInitHandshake() }, 250L)
    }

    private val registerTimeout = Runnable {
        val index = pendingRegister ?: return@Runnable
        appendLog("READ timeout register 0x" + index.toString(16).uppercase())
        pendingRegister = null
        readNextRegister()
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        buildUi()
        appendLog("BUILD " + BUILD_ID)
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
            text = "Ninebot E3 Pro Controller · r7"
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
        }
        root.addView(ScrollView(this).apply {
            isVerticalScrollBarEnabled = true
            isNestedScrollingEnabled = true
            addView(deviceList)
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(220)))

        root.addView(TextView(this).apply {
            text = "SPORT SPEED"
            textSize = 13f
            setPadding(0, dp(10), 0, dp(4))
        })

        val sportRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }

        sport25Button = Button(this).apply {
            text = "25 km/h"
            isEnabled = false
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { requestSportSpeed(25) }
        }
        sport32Button = Button(this).apply {
            text = "32 km/h"
            isEnabled = false
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { requestSportSpeed(32) }
        }
        sportRow.addView(sport25Button)
        sportRow.addView(sport32Button)
        root.addView(sportRow)

        sportStatusView = TextView(this).apply {
            text = "Waiting for authenticated controller readback"
            setPadding(0, dp(4), 0, dp(8))
        }
        root.addView(sportStatusView)

        root.addView(TextView(this).apply {
            text = "The ✓ appears only after the scooter reports the requested limit back."
            setPadding(0, 0, 0, dp(8))
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
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(300))
        )

        setContentView(page)
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

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
            val scanGranted =
                checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
            val connectGranted =
                checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            if (!scanGranted || !connectGranted) {
                appendLog("Requesting Bluetooth permissions.")
                requestPermissions(
                    arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT),
                    PERMISSION_REQUEST
                )
                return
            }
        }
        startScan()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        results: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != PERMISSION_REQUEST) return
        if (results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED }) {
            appendLog("Bluetooth permissions granted.")
            startScan()
        } else {
            setStatus("Bluetooth permission required")
            appendLog("Bluetooth permission denied.")
        }
    }

    private fun startScan() {
        handler.removeCallbacks(retryScan)
        handler.removeCallbacks(stopScanAfterTimeout)

        if (Build.VERSION.SDK_INT >= 31 &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED
        ) {
            ensurePermissionsAndAutoScan()
            return
        }

        val adapter = (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (!adapter.isEnabled) {
            setStatus("Bluetooth disabled")
            scheduleRetry("Bluetooth disabled.")
            return
        }

        if (scanning) return

        found.clear()
        autoConnectAttempted = false
        deviceList.removeAllViews()
        scanner = adapter.bluetoothLeScanner

        if (scanner == null) {
            setStatus("BLE scanner unavailable")
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
                if (found.containsKey(device.address)) return@runOnUiThread

                found[device.address] = device
                val name = device.name ?: "Unknown BLE device"
                appendLog("Found: " + name + " / " + device.address + " / RSSI " + result.rssi)

                deviceList.addView(Button(this@MainActivity).apply {
                    text = name + "\n" + device.address + " (" + result.rssi + " dBm)"
                    setOnClickListener { connect(device) }
                })

                val savedAddress = prefs.getString("last_nus_address", null)
                if (!autoConnectAttempted &&
                    savedAddress != null &&
                    savedAddress.equals(device.address, ignoreCase = true)
                ) {
                    autoConnectAttempted = true
                    appendLog("Known scooter found; auto-connecting.")
                    connect(device)
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
        resetProtocolState()
        gatt?.close()
        setStatus("Connecting to " + (device.name ?: device.address))
        appendLog("Connecting to " + device.address + "…")
        gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private fun resetProtocolState() {
        handler.removeCallbacks(pairRetry)
        handler.removeCallbacks(registerTimeout)
        handler.removeCallbacks(initTimeout)
        handler.removeCallbacks(protocolProbeTimeout)
        authState = AuthState.IDLE
        protocolMode = ProtocolMode.UNKNOWN
        crypto = null
        scooterSerial = null
        nusRx = null
        encryptedRxBuffer.reset()
        writeChunks.clear()
        writeInProgress = false
        registerQueue.clear()
        registerRaw.clear()
        pendingRegister = null
        pendingTargetKmh = null
        ratedMaxKmh = null
        speedReleaseScale = 1
        initAttempt = 0
        useWriteNoResponse = false
        sport25Button.isEnabled = false
        sport32Button.isEnabled = false
        sport25Button.text = "25 km/h"
        sport32Button.text = "32 km/h"
        sportStatusView.text = "Waiting for authenticated controller readback"
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS &&
                    newState == BluetoothProfile.STATE_CONNECTED
                ) {
                    setStatus("Connected · discovering services")
                    appendLog("Connected. Discovering GATT services.")
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    appendLog("Disconnected. GATT status=" + status + ".")
                    setStatus("Disconnected")
                    g.close()
                    if (gatt === g) gatt = null
                    scheduleRetry("Connection lost or failed.")
                } else {
                    appendLog("GATT state=" + newState + ", status=" + status + ".")
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            handler.post {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    appendLog("Service discovery failed: " + status + ".")
                    setStatus("Service discovery failed")
                    g.disconnect()
                    return@post
                }

                logGattLayout(g)

                val nus = g.getService(UUID_NUS_SERVICE)
                val tx = nus?.getCharacteristic(UUID_NUS_TX)
                val rx = nus?.getCharacteristic(UUID_NUS_RX)

                if (tx == null || rx == null) {
                    setStatus("Connected · Ninebot NUS not found")
                    appendLog("Expected Ninebot NUS transport is incomplete.")
                    return@post
                }

                nusRx = rx
                prefs.edit()
                    .putString("last_nus_address", g.device.address)
                    .putString("last_nus_name", g.device.name)
                    .apply()

                setStatus("Connected · enabling Ninebot notifications")
                val local = g.setCharacteristicNotification(tx, true)
                appendLog("NUS detected. Local notification routing=" + local)

                val cccd = tx.getDescriptor(UUID_CCCD)
                if (cccd == null) {
                    appendLog("NUS TX CCCD missing.")
                    return@post
                }

                val result = if (Build.VERSION.SDK_INT >= 33) {
                    g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                } else {
                    @Suppress("DEPRECATION")
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    if (g.writeDescriptor(cccd)) BluetoothStatusCodes.SUCCESS
                    else BluetoothStatusCodes.ERROR_UNKNOWN
                }
                appendLog("Notification subscription request=" + result)
            }
        }

        override fun onDescriptorWrite(
            g: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int
        ) {
            handler.post {
                if (descriptor.uuid != UUID_CCCD) return@post
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    appendLog("✓ NUS TX notifications enabled.")
                    beginProtocolDetection(g)
                } else {
                    appendLog("Notification subscription failed. status=" + status)
                    setStatus("Notification setup failed")
                }
            }
        }

        override fun onCharacteristicWrite(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            handler.post {
                writeInProgress = false
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    appendLog("NUS write chunk failed. status=" + status)
                    writeChunks.clear()
                    authState = AuthState.FAILED
                    setStatus("Protocol write failed")
                    return@post
                }
                drainWriteQueue(g)
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            val value = characteristic.value ?: byteArrayOf()
            handler.post { handleNotification(value) }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handler.post { handleNotification(value) }
        }
    }

    private fun logGattLayout(g: BluetoothGatt) {
        val out = StringBuilder("GATT services discovered:")
        for (service in g.services) {
            out.append("\nSERVICE ").append(service.uuid)
            for (c in service.characteristics) {
                out.append("\n  ").append(c.uuid)
                    .append(" props=").append(c.properties)
                    .append(" [").append(propertyNames(c.properties)).append("]")
            }
        }
        appendLog(out.toString())
    }

    private fun beginProtocolDetection(g: BluetoothGatt) {
        handler.removeCallbacks(protocolProbeTimeout)
        protocolMode = ProtocolMode.PROBING_LEGACY
        useWriteNoResponse = true
        setStatus("Detecting Ninebot protocol…")
        appendLog("PROBE legacy 55 AA · read firmware register 0x1A")
        sendLegacyRead(0x1A, 2)
        handler.postDelayed(protocolProbeTimeout, PROTOCOL_PROBE_TIMEOUT_MS)
    }

    private fun sendLegacyRead(index: Int, byteCount: Int) {
        sendLegacyFrame(0x01, index, byteArrayOf(byteCount.toByte()))
    }

    private fun sendLegacyWrite(index: Int, rawValue: Int) {
        val payload = byteArrayOf(
            (rawValue and 0xff).toByte(),
            ((rawValue shr 8) and 0xff).toByte()
        )
        sendLegacyFrame(0x03, index, payload)
    }

    private fun sendLegacyFrame(command: Int, index: Int, payload: ByteArray) {
        val body = ByteArray(4 + payload.size)
        body[0] = (payload.size + 2).toByte()
        body[1] = 0x20
        body[2] = command.toByte()
        body[3] = index.toByte()
        payload.copyInto(body, 4)

        var sum = 0
        for (b in body) sum += b.toInt() and 0xff
        val checksum = sum.inv() and 0xffff

        val frame = ByteArray(2 + body.size + 2)
        frame[0] = 0x55
        frame[1] = 0xAA.toByte()
        body.copyInto(frame, 2)
        frame[frame.size - 2] = (checksum and 0xff).toByte()
        frame[frame.size - 1] = ((checksum shr 8) and 0xff).toByte()

        appendLog(
            "TX 55AA cmd=0x" + command.toString(16).uppercase() +
                " idx=0x" + index.toString(16).uppercase() +
                " · " + packetSummary(frame)
        )

        useWriteNoResponse = true
        enqueueGattFrame(frame)
    }

    private fun handleLegacyFrame(frame: ByteArray) {
        if (frame.size < 8 || frame[0] != 0x55.toByte() || frame[1] != 0xAA.toByte()) {
            appendLog("Invalid 55 AA frame.")
            return
        }

        val lengthField = frame[2].toInt() and 0xff
        val expectedSize = lengthField + 6
        if (frame.size < expectedSize) {
            appendLog("Incomplete 55 AA frame: got=" + frame.size + " expected=" + expectedSize)
            return
        }

        var sum = 0
        for (i in 2 until expectedSize - 2) sum += frame[i].toInt() and 0xff
        val checksum = sum.inv() and 0xffff
        val receivedChecksum =
            (frame[expectedSize - 2].toInt() and 0xff) or
                ((frame[expectedSize - 1].toInt() and 0xff) shl 8)

        if (checksum != receivedChecksum) {
            appendLog(
                "55 AA checksum mismatch calc=0x" + checksum.toString(16).uppercase() +
                    " recv=0x" + receivedChecksum.toString(16).uppercase()
            )
            return
        }

        handler.removeCallbacks(protocolProbeTimeout)
        if (protocolMode != ProtocolMode.LEGACY_55AA) {
            protocolMode = ProtocolMode.LEGACY_55AA
            authState = AuthState.AUTHENTICATED
            appendLog("✓ Legacy Ninebot 55 AA protocol detected.")
            setStatus("✓ Connected · legacy Ninebot protocol")
        }

        val device = frame[3].toInt() and 0xff
        val command = frame[4].toInt() and 0xff
        val index = frame[5].toInt() and 0xff
        val dataLength = maxOf(0, lengthField - 2)
        val dataEnd = minOf(6 + dataLength, expectedSize - 2)
        val data = if (dataEnd > 6) frame.copyOfRange(6, dataEnd) else byteArrayOf()

        appendLog(
            "RX 55AA dev=0x" + device.toString(16).uppercase() +
                " cmd=0x" + command.toString(16).uppercase() +
                " idx=0x" + index.toString(16).uppercase() +
                " data=" + packetSummary(data)
        )

        if (command != 0x01) return

        when (index) {
            0x1A -> {
                appendLog("Legacy firmware probe answered; reading speed register 0x73.")
                sendLegacyRead(REG_NORMAL_SPEED, 4)
            }

            REG_NORMAL_SPEED -> handleLegacySpeedRead(data)
        }
    }

    private fun handleLegacySpeedRead(data: ByteArray) {
        if (data.size < 2) {
            sportStatusView.text = "Speed register response too short"
            return
        }

        val raw = (data[0].toInt() and 0xff) or ((data[1].toInt() and 0xff) shl 8)
        val currentKmh = raw / 1000.0
        registerRaw[REG_NORMAL_SPEED] = raw

        val limitedRaw = if (data.size >= 4) {
            (data[2].toInt() and 0xff) or ((data[3].toInt() and 0xff) shl 8)
        } else null

        appendLog(
            "LEGACY speed 0x73 raw=" + raw +
                " = " + formatSpeed(currentKmh) + " km/h" +
                if (limitedRaw != null) " · 0x74 raw=" + limitedRaw else ""
        )

        val target = pendingTargetKmh
        if (target != null) {
            pendingTargetKmh = null
            if (abs(currentKmh - target) <= 0.6) {
                markSportConfirmed(target)
            } else {
                sportStatusView.text =
                    "✗ Requested " + target + ", scooter reports " +
                        formatSpeed(currentKmh) + " km/h"
                appendLog(
                    "SPORT verification failed: requested=" + target +
                        " readback=" + currentKmh
                )
                updateSportButtons()
            }
            return
        }

        sportStatusView.text =
            "Current Sport limit ≈ " + formatSpeed(currentKmh) +
                " km/h · legacy 55 AA"
        updateSportButtons()
        setStatus("✓ Connected · 25/32 control ready")
    }

    private fun beginAuthentication(g: BluetoothGatt) {
        protocolName = g.device.name ?: prefs.getString("last_nus_name", null) ?: "Ninebot"
        initAttempt = 0
        useWriteNoResponse = false
        attemptInitHandshake()
    }

    private fun attemptInitHandshake() {
        handler.removeCallbacks(initTimeout)
        encryptedRxBuffer.reset()
        writeChunks.clear()
        writeInProgress = false

        crypto = ProtocolNinebot(protocolName)
        authState = AuthState.INIT_SENT

        setStatus(
            "Authenticating · INIT " + (initAttempt + 1) + "/" + INIT_MAX_ATTEMPTS +
                " · " + if (useWriteNoResponse) "write NR" else "write request"
        )
        appendLog(
            "AUTH INIT → dashboard · attempt " + (initAttempt + 1) + "/" + INIT_MAX_ATTEMPTS +
                " · mode=" + if (useWriteNoResponse) "WRITE_NO_RESPONSE" else "WRITE_REQUEST"
        )
        sendProtocolPacket(BLE, CMD_INIT, 0, byteArrayOf())
        handler.postDelayed(initTimeout, INIT_TIMEOUT_MS)
    }

    private fun persistentAppKey(): ByteArray {
        val saved = prefs.getString("app_key", null)
        if (saved != null) {
            return Base64.decode(saved, Base64.NO_WRAP)
        }
        val key = ByteArray(16)
        SecureRandom().nextBytes(key)
        prefs.edit().putString("app_key", Base64.encodeToString(key, Base64.NO_WRAP)).apply()
        appendLog("Generated persistent local pairing key.")
        return key
    }

    private fun sendPairPing() {
        if (authState != AuthState.WAIT_PAIR) return
        sendProtocolPacket(BLE, CMD_PING, 0, persistentAppKey())
    }

    private fun sendProtocolPacket(
        target: Int,
        command: Int,
        index: Int,
        payload: ByteArray
    ) {
        val c = crypto ?: return
        val raw = ByteArray(7 + payload.size)
        raw[0] = 0x5A
        raw[1] = 0xA5.toByte()
        raw[2] = payload.size.toByte()
        raw[3] = CLIENT.toByte()
        raw[4] = target.toByte()
        raw[5] = command.toByte()
        raw[6] = index.toByte()
        payload.copyInto(raw, 7)

        appendLog(
            "TX proto dst=0x" + target.toString(16).uppercase() +
                " cmd=0x" + command.toString(16).uppercase() +
                " idx=0x" + index.toString(16).uppercase() +
                " payload=" + payload.size + " B"
        )

        val encrypted = c.encrypt(raw)
        if (command == CMD_INIT) {
            appendLog("TX INIT encrypted · " + packetSummary(encrypted))
        }
        enqueueGattFrame(encrypted)
    }

    private fun enqueueGattFrame(frame: ByteArray) {
        var offset = 0
        while (offset < frame.size) {
            val end = minOf(offset + 20, frame.size)
            writeChunks.add(frame.copyOfRange(offset, end))
            offset = end
        }
        gatt?.let { drainWriteQueue(it) }
    }

    private fun drainWriteQueue(g: BluetoothGatt) {
        if (writeInProgress) return
        val chunk = writeChunks.pollFirst() ?: return
        val rx = nusRx ?: return
        val writeType =
            if (useWriteNoResponse) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT

        writeInProgress = true
        val started = if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(rx, chunk, writeType) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            rx.writeType = writeType
            @Suppress("DEPRECATION")
            rx.value = chunk
            @Suppress("DEPRECATION")
            g.writeCharacteristic(rx)
        }

        if (!started) {
            writeInProgress = false
            writeChunks.clear()
            appendLog("Could not start NUS write type=" + writeType)
            setStatus("Protocol write failed")
            return
        }

        if (useWriteNoResponse) {
            writeInProgress = false
            if (writeChunks.isNotEmpty()) {
                handler.postDelayed({ drainWriteQueue(g) }, 20L)
            }
        }
    }

    private fun handleNotification(value: ByteArray) {
        appendLog("RX NUS RAW · " + packetSummary(value))

        if (value.size >= 2 && value[0] == 0x55.toByte() && value[1] == 0xAA.toByte()) {
            handleLegacyFrame(value)
            return
        }

        if (authState == AuthState.INIT_SENT) handler.removeCallbacks(initTimeout)

        if (encryptedRxBuffer.size() == 0 &&
            (value.size < 2 || value[0] != 0x5A.toByte() || value[1] != 0xA5.toByte())
        ) {
            appendLog("Ignoring orphan NUS fragment.")
            return
        }

        encryptedRxBuffer.write(value)
        processEncryptedFrames()
    }

    private fun processEncryptedFrames() {
        while (true) {
            val buffer = encryptedRxBuffer.toByteArray()
            if (buffer.size < 3) return

            val expectedEncryptedLength = (buffer[2].toInt() and 0xff) + 13
            if (buffer.size < expectedEncryptedLength) return

            val frame = buffer.copyOfRange(0, expectedEncryptedLength)
            val remainder = buffer.copyOfRange(expectedEncryptedLength, buffer.size)
            encryptedRxBuffer.reset()
            encryptedRxBuffer.write(remainder)

            val c = crypto ?: return
            val decrypted = try {
                c.decrypt(frame)
            } catch (e: Exception) {
                appendLog("Decrypt failed: " + (e.message ?: e.javaClass.simpleName))
                authState = AuthState.FAILED
                setStatus("Ninebot authentication failed")
                return
            }

            appendLog("RX proto · " + packetSummary(decrypted))
            handleProtocolPacket(decrypted)
        }
    }

    private fun handleProtocolPacket(packet: ByteArray) {
        if (packet.size < 7 ||
            packet[0] != 0x5A.toByte() ||
            packet[1] != 0xA5.toByte()
        ) {
            appendLog("Decoded packet has invalid header.")
            return
        }

        val source = packet[3].toInt() and 0xff
        val target = packet[4].toInt() and 0xff
        val command = packet[5].toInt() and 0xff
        val index = packet[6].toInt() and 0xff
        val payloadLength = packet[2].toInt() and 0xff
        val available = maxOf(0, minOf(payloadLength, packet.size - 7))
        val payload = packet.copyOfRange(7, 7 + available)

        appendLog(
            "PROTO src=0x" + source.toString(16).uppercase() +
                " dst=0x" + target.toString(16).uppercase() +
                " cmd=0x" + command.toString(16).uppercase() +
                " idx=0x" + index.toString(16).uppercase() +
                " len=" + payload.size
        )

        when {
            source == BLE && target == CLIENT && command == CMD_INIT -> {
                handler.removeCallbacks(initTimeout)
                if (payload.size < 30) {
                    authFailure("INIT payload too short: " + payload.size)
                    return
                }
                scooterSerial = payload.copyOfRange(16, 30)
                val serialText = scooterSerial!!.toString(Charsets.US_ASCII)
                appendLog("AUTH serial=" + serialText)
                authState = AuthState.WAIT_PAIR
                setStatus("Pairing…")
                handler.removeCallbacks(pairRetry)
                sendPairPing()
                handler.postDelayed(pairRetry, PAIR_RETRY_MS)
            }

            source == BLE && target == CLIENT && command == CMD_PING -> {
                if (index == 1) {
                    handler.removeCallbacks(pairRetry)
                    appendLog("✓ Pair key accepted.")
                    val serial = scooterSerial
                    if (serial == null) {
                        authFailure("Serial unavailable for final PAIR.")
                        return
                    }
                    authState = AuthState.PAIR_SENT
                    sendProtocolPacket(BLE, CMD_PAIR, 0, serial)
                } else {
                    setStatus("Pairing · press power button once")
                    appendLog("Pair waiting for scooter confirmation.")
                }
            }

            source == BLE && target == CLIENT && command == CMD_PAIR -> {
                if (index == 1) {
                    authState = AuthState.AUTHENTICATED
                    appendLog("✓ Ninebot application pairing authenticated.")
                    setStatus("✓ Authenticated · reading controller")
                    beginSpeedRegisterProbe()
                } else {
                    authFailure("PAIR rejected with index=" + index)
                }
            }

            source == CONTROL && target == CLIENT && command == CMD_READ_ACK -> {
                handleRegisterRead(index, payload)
            }
        }
    }

    private fun authFailure(reason: String) {
        handler.removeCallbacks(pairRetry)
        handler.removeCallbacks(initTimeout)
        authState = AuthState.FAILED
        setStatus("Authentication failed")
        appendLog("AUTH failed: " + reason)
        sportStatusView.text = "Authentication failed — see trace"
    }

    private fun beginSpeedRegisterProbe() {
        registerQueue.clear()
        registerRaw.clear()
        pendingRegister = null
        registerQueue.add(REG_RATED_MAX)
        registerQueue.add(REG_SPEED_RELEASE)
        registerQueue.add(REG_NORMAL_SPEED)
        registerQueue.add(REG_LIMITED_SPEED)
        appendLog("Reading speed capability registers 0x48, 0x72, 0x73, 0x74.")
        readNextRegister()
    }

    private fun readNextRegister() {
        if (authState != AuthState.AUTHENTICATED) return
        if (pendingRegister != null) return

        val index = registerQueue.pollFirst()
        if (index == null) {
            evaluateSpeedRegisters()
            return
        }

        pendingRegister = index
        handler.removeCallbacks(registerTimeout)
        handler.postDelayed(registerTimeout, REGISTER_TIMEOUT_MS)
        sendProtocolPacket(CONTROL, CMD_READ, index, byteArrayOf(2))
    }

    private fun handleRegisterRead(index: Int, payload: ByteArray) {
        if (payload.size < 2) {
            appendLog("Register 0x" + index.toString(16).uppercase() + " returned " + payload.size + " B")
            return
        }

        val raw = (payload[0].toInt() and 0xff) or
            ((payload[1].toInt() and 0xff) shl 8)

        appendLog(
            "READ 0x" + index.toString(16).uppercase() +
                " raw=" + raw + " (0x" + raw.toString(16).uppercase() + ")"
        )

        if (pendingTargetKmh != null && index == REG_SPEED_RELEASE) {
            handler.removeCallbacks(registerTimeout)
            pendingRegister = null
            val target = pendingTargetKmh!!
            val effective = raw.toDouble() / speedReleaseScale.toDouble()
            if (abs(effective - target) <= 0.6) {
                pendingTargetKmh = null
                markSportConfirmed(target)
                return
            }

            pendingTargetKmh = null
            sportStatusView.text =
                "✗ Scooter reports " + formatSpeed(effective) + " km/h after request"
            appendLog(
                "SPORT verification failed: requested=" + target +
                    " readback=" + effective
            )
            updateSportButtons()
            return
        }

        registerRaw[index] = raw
        if (pendingRegister == index) {
            handler.removeCallbacks(registerTimeout)
            pendingRegister = null
            readNextRegister()
        }
    }

    private fun evaluateSpeedRegisters() {
        val ratedRaw = registerRaw[REG_RATED_MAX]
        val releaseRaw = registerRaw[REG_SPEED_RELEASE]
        val normalRaw = registerRaw[REG_NORMAL_SPEED]
        val limitedRaw = registerRaw[REG_LIMITED_SPEED]

        val ratedScale = ratedRaw?.let { inferSpeedScale(it) }
        ratedMaxKmh = if (ratedRaw != null && ratedScale != null) {
            ratedRaw.toDouble() / ratedScale
        } else null

        speedReleaseScale =
            releaseRaw?.takeIf { it > 0 }?.let { inferSpeedScale(it) } ?: 1

        appendLog(
            "SPEED probe rated=" + interpreted(ratedRaw, ratedScale) +
                " release=" + interpreted(releaseRaw, speedReleaseScale) +
                " normal=" + interpreted(normalRaw, normalRaw?.let { inferSpeedScale(it) }) +
                " limited=" + interpreted(limitedRaw, limitedRaw?.let { inferSpeedScale(it) })
        )

        val rated = ratedMaxKmh
        if (rated == null) {
            sportStatusView.text = "Could not verify rated maximum — 32 disabled"
            sport25Button.isEnabled = releaseRaw != null
            sport32Button.isEnabled = false
            return
        }

        updateSportButtons()

        sportStatusView.text =
            "Controller rated max ≈ " + formatSpeed(rated) +
                " km/h · release scale ×" + speedReleaseScale

        if (rated >= 31.5) {
            appendLog("✓ Controller capability is compatible with 32 km/h.")
            setStatus("✓ Authenticated · 25/32 control ready")
        } else {
            appendLog("32 km/h button disabled: rated controller value is below 32.")
            setStatus("✓ Authenticated · controller max " + formatSpeed(rated) + " km/h")
        }
    }

    private fun inferSpeedScale(raw: Int): Int? {
        if (raw <= 0) return null
        val candidates = intArrayOf(1, 10, 100, 1000)
        return candidates
            .map { scale -> scale to raw.toDouble() / scale }
            .filter { (_, kmh) -> kmh in 5.0..60.0 }
            .minByOrNull { (_, kmh) ->
                val known = doubleArrayOf(15.0, 20.0, 25.0, 30.0, 32.0, 35.0, 40.0)
                known.minOf { abs(it - kmh) }
            }
            ?.first
    }

    private fun updateSportButtons() {
        if (protocolMode == ProtocolMode.LEGACY_55AA) {
            val ready =
                authState == AuthState.AUTHENTICATED &&
                    registerRaw.containsKey(REG_NORMAL_SPEED) &&
                    pendingTargetKmh == null
            sport25Button.isEnabled = ready
            sport32Button.isEnabled = ready
            return
        }

        val ready = authState == AuthState.AUTHENTICATED &&
            registerRaw.containsKey(REG_SPEED_RELEASE) &&
            pendingTargetKmh == null

        sport25Button.isEnabled = ready && (ratedMaxKmh ?: 0.0) >= 24.5
        sport32Button.isEnabled = ready && (ratedMaxKmh ?: 0.0) >= 31.5
    }

    private fun requestSportSpeed(targetKmh: Int) {
        if (protocolMode == ProtocolMode.LEGACY_55AA) {
            if (authState != AuthState.AUTHENTICATED ||
                !registerRaw.containsKey(REG_NORMAL_SPEED)
            ) {
                toast("Scooter speed register is not ready yet")
                return
            }

            val raw = targetKmh * 1000
            pendingTargetKmh = targetKmh
            updateSportButtons()
            sportStatusView.text = "Applying " + targetKmh + " km/h…"
            appendLog(
                "SPORT legacy write 0x73 target=" + targetKmh +
                    " km/h raw=" + raw
            )
            sendLegacyWrite(REG_NORMAL_SPEED, raw)

            handler.postDelayed({
                if (pendingTargetKmh == targetKmh) {
                    sendLegacyRead(REG_NORMAL_SPEED, 4)
                }
            }, 450L)
            return
        }

        if (authState != AuthState.AUTHENTICATED) {
            toast("Scooter is not authenticated yet")
            return
        }

        val rated = ratedMaxKmh
        if (rated == null || rated + 0.5 < targetKmh) {
            sportStatusView.text = "✗ Controller does not report " + targetKmh + " km/h capability"
            return
        }

        if (!registerRaw.containsKey(REG_SPEED_RELEASE)) {
            sportStatusView.text = "✗ Speed release register was not readable"
            return
        }

        val raw = targetKmh * speedReleaseScale
        if (raw !in 0..65535) {
            sportStatusView.text = "✗ Invalid controller scaling"
            return
        }

        pendingTargetKmh = targetKmh
        updateSportButtons()
        sportStatusView.text = "Applying " + targetKmh + " km/h…"
        appendLog(
            "SPORT write 0x72 target=" + targetKmh +
                " km/h raw=" + raw + " scale=" + speedReleaseScale
        )

        val payload = byteArrayOf(
            (raw and 0xff).toByte(),
            ((raw shr 8) and 0xff).toByte()
        )
        sendProtocolPacket(CONTROL, CMD_WRITE_NO_REPLY, REG_SPEED_RELEASE, payload)

        handler.postDelayed({
            if (pendingTargetKmh == targetKmh) {
                pendingRegister = REG_SPEED_RELEASE
                handler.removeCallbacks(registerTimeout)
                handler.postDelayed(registerTimeout, REGISTER_TIMEOUT_MS)
                sendProtocolPacket(CONTROL, CMD_READ, REG_SPEED_RELEASE, byteArrayOf(2))
            }
        }, 500L)
    }

    private fun markSportConfirmed(targetKmh: Int) {
        sport25Button.text = if (targetKmh == 25) "✓ 25 km/h" else "25 km/h"
        sport32Button.text = if (targetKmh == 32) "✓ 32 km/h" else "32 km/h"
        sportStatusView.text = "✓ " + targetKmh + " km/h confirmed by scooter"
        appendLog("✓ SPORT limit effective: " + targetKmh + " km/h read back from controller.")
        setStatus("✓ Connected · Sport " + targetKmh + " km/h")
        updateSportButtons()
        toast("✓ " + targetKmh + " km/h confirmed")
    }

    private fun interpreted(raw: Int?, scale: Int?): String {
        if (raw == null) return "n/a"
        if (scale == null || scale == 0) return raw.toString() + " raw"
        return raw.toString() + " → " + formatSpeed(raw.toDouble() / scale) + " km/h"
    }

    private fun formatSpeed(value: Double): String =
        if (abs(value - value.toInt()) < 0.01) value.toInt().toString()
        else String.format(Locale.US, "%.1f", value)

    private fun packetSummary(value: ByteArray): String {
        val hex = value.joinToString(" ") { "%02X".format(it.toInt() and 0xff) }
        val ascii = buildString {
            value.forEach { byte ->
                val c = byte.toInt() and 0xff
                append(if (c in 32..126) c.toChar() else '.')
            }
        }
        return value.size.toString() + " B · HEX [" + hex + "] · ASCII [" + ascii + "]"
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

    private fun setStatus(text: String) {
        statusView.text = text
    }

    private fun appendLog(message: String) {
        val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
        if (trace.isNotEmpty()) trace.append('\n')
        trace.append('[').append(time).append("] ").append(message)
        logView.text = trace.toString()
        logBody.post { logBody.fullScroll(View.FOCUS_DOWN) }
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    }

    override fun onDestroy() {
        handler.removeCallbacks(retryScan)
        handler.removeCallbacks(stopScanAfterTimeout)
        handler.removeCallbacks(pairRetry)
        handler.removeCallbacks(registerTimeout)
        if (scanning) scanner?.stopScan(scanCallback)
        gatt?.close()
        super.onDestroy()
    }
}

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
import com.example.ninebote3.protocol.ClassicNbCrypto
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.math.abs

class MainActivity : Activity() {
    companion object {
        private const val BUILD_ID = "r12-reference-handshake"
        private const val PERMISSION_REQUEST = 10
        private const val SCAN_DURATION_MS = 10_000L
        private const val RETRY_DEBOUNCE_MS = 2_000L
        private const val REQUEST_TIMEOUT_MS = 20_000L
        private const val REGISTER_TIMEOUT_MS = 3_500L
        private const val REQUEST_MTU = 185
        private const val PING_RETRY_MS = 1_200L
        private const val CLASSIC_CHUNK_SIZE = 20

        private val UUID_NUS_SERVICE =
            UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_RX =
            UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_TX =
            UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_CCCD =
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        private const val PC = 0x3D
        private const val ES_CONTROL = 0x20
        private const val ES_BLE = 0x21

        private const val CMD_READ = 0x01
        private const val CMD_WRITE_NO_REPLY = 0x03
        private const val CMD_READ_ACK = 0x04
        private const val CMD_INIT = 0x5B
        private const val CMD_PING = 0x5C
        private const val CMD_PAIR = 0x5D

        private const val REG_FIRMWARE = 0x1A
        private const val REG_LIMIT_RELEASE = 0x72
        private const val REG_NORMAL_SPEED = 0x73
        private const val REG_LIMITED_SPEED = 0x74
        private const val REG_WORK_MODE = 0x75
    }

    private enum class SessionState {
        IDLE,
        INIT,
        PING,
        PROBING,
        READY,
        FAILED
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
    private val prefs by lazy {
        getSharedPreferences("ninebot", MODE_PRIVATE)
    }

    private val trace = StringBuilder()
    private val found = linkedMapOf<String, BluetoothDevice>()

    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var gatt: BluetoothGatt? = null
    private var nusRx: BluetoothGattCharacteristic? = null
    private var autoConnectAttempted = false
    private var selectedBleName = ""
    private var negotiatedMtu = 23
    private var servicesStarted = false

    private var state = SessionState.IDLE
    private var crypto = ClassicNbCrypto()
    private val rxBuffer = ByteArrayOutputStream()

    private var bleKey = ByteArray(0)
    private var scooterSerial = ByteArray(0)
    private var appKey = ByteArray(0)

    private var probeStep = 0
    private var lastConfirmedCounter = 0
    private var pingAttempts = 0
    private var pendingReadIndex: Int? = null
    private val speedReadQueue = ArrayDeque<Int>()
    private val speedRaw = linkedMapOf<Int, Int>()

    private val writeChunks = ArrayDeque<ByteArray>()
    private var writeInProgress = false

    private val retryScan = Runnable {
        appendLog("Retry debounce elapsed; starting scan.")
        startScan()
    }

    private val stopScanAfterTimeout = Runnable {
        if (scanning) {
            stopScan("Scan timeout.")
            if (found.isEmpty()) {
                scheduleRetry("No BLE devices found.")
            }
        }
    }

    private val pingRetry = object : Runnable {
        override fun run() {
            if (state != SessionState.PING) return

            pingAttempts += 1
            appendLog(
                "PING attempt " + pingAttempts +
                    " · 20-byte classic transport"
            )

            sendClassic(
                target = ES_BLE,
                command = CMD_PING,
                index = 0,
                payload = appKey
            )

            handler.postDelayed(this, PING_RETRY_MS)
        }
    }

    private val requestTimeout = Runnable {
        when (state) {
            SessionState.INIT ->
                failSession("Classic INIT timed out.")

            SessionState.PING -> {
                handler.removeCallbacks(pingRetry)
                appendLog(
                    "Classic PING timed out after " + REQUEST_TIMEOUT_MS +
                        " ms and " + pingAttempts + " attempt(s)."
                )
                failSession("Classic PING did not answer; session counter is unknown.")
            }

            SessionState.PROBING ->
                tryNextSessionKey()

            else -> Unit
        }
    }

    private val registerTimeout = Runnable {
        val index = pendingReadIndex ?: return@Runnable
        appendLog("READ timeout controller 0x" + hex2(index))
        pendingReadIndex = null
        readNextSpeedRegister()
    }

    override fun onCreate(stateBundle: Bundle?) {
        super.onCreate(stateBundle)
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
            text = "Ninebot E3 Pro Controller · r12"
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
                if (scanning) {
                    stopScan("Scan stopped by user.")
                } else {
                    startScan()
                }
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

        root.addView(
            ScrollView(this).apply {
                isVerticalScrollBarEnabled = true
                isNestedScrollingEnabled = true
                addView(deviceList)
            },
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(220)
            )
        )

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
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        }

        sport32Button = Button(this).apply {
            text = "32 km/h"
            isEnabled = false
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
        }

        sportRow.addView(sport25Button)
        sportRow.addView(sport32Button)
        root.addView(sportRow)

        sportStatusView = TextView(this).apply {
            text = "Waiting for classic session verification"
            setPadding(0, dp(4), 0, dp(8))
        }
        root.addView(sportStatusView)

        root.addView(TextView(this).apply {
            text =
                "r12 mirrors the working classic handshake: 20-byte transport, repeated PING, counter-safe session probes."
            setPadding(0, 0, 0, dp(8))
        })

        val logActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }

        logToggle = Button(this).apply {
            text = "TRACE LOG ▶"
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            )
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
                dp(330)
            )
        )

        setContentView(page)
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private fun toggleLog() {
        val open =
            logBody.visibility != View.VISIBLE

        logBody.visibility =
            if (open) View.VISIBLE else View.GONE

        logToggle.text =
            if (open) "TRACE LOG ▼" else "TRACE LOG ▶"
    }

    private fun copyTrace() {
        val clipboard =
            getSystemService(CLIPBOARD_SERVICE) as ClipboardManager

        clipboard.setPrimaryClip(
            ClipData.newPlainText(
                "Ninebot BLE trace",
                trace.toString()
            )
        )

        toast("Trace copied")
    }

    private fun ensurePermissionsAndAutoScan() {
        if (Build.VERSION.SDK_INT >= 31) {
            val scanGranted =
                checkSelfPermission(
                    Manifest.permission.BLUETOOTH_SCAN
                ) == PackageManager.PERMISSION_GRANTED

            val connectGranted =
                checkSelfPermission(
                    Manifest.permission.BLUETOOTH_CONNECT
                ) == PackageManager.PERMISSION_GRANTED

            if (!scanGranted || !connectGranted) {
                appendLog("Requesting Bluetooth permissions.")

                requestPermissions(
                    arrayOf(
                        Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.BLUETOOTH_CONNECT
                    ),
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
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(
            requestCode,
            permissions,
            grantResults
        )

        if (requestCode != PERMISSION_REQUEST) {
            return
        }

        if (grantResults.isNotEmpty() &&
            grantResults.all {
                it == PackageManager.PERMISSION_GRANTED
            }
        ) {
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
            checkSelfPermission(
                Manifest.permission.BLUETOOTH_SCAN
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            ensurePermissionsAndAutoScan()
            return
        }

        val adapter =
            (getSystemService(BLUETOOTH_SERVICE)
                as BluetoothManager).adapter

        if (!adapter.isEnabled) {
            setStatus("Bluetooth disabled")
            scheduleRetry("Bluetooth disabled.")
            return
        }

        if (scanning) {
            return
        }

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

        handler.postDelayed(
            stopScanAfterTimeout,
            SCAN_DURATION_MS
        )
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

        appendLog(
            reason +
                " Retry scheduled in " +
                RETRY_DEBOUNCE_MS +
                " ms."
        )

        handler.postDelayed(
            retryScan,
            RETRY_DEBOUNCE_MS
        )
    }

    private val scanCallback =
        object : ScanCallback() {
            override fun onScanResult(
                callbackType: Int,
                result: ScanResult
            ) {
                runOnUiThread {
                    val device = result.device

                    if (found.containsKey(device.address)) {
                        return@runOnUiThread
                    }

                    found[device.address] = device

                    val advertisedName =
                        result.scanRecord?.deviceName
                            ?: device.name
                            ?: "Unknown BLE device"

                    appendLog(
                        "Found: " +
                            advertisedName +
                            " / " +
                            device.address +
                            " / RSSI " +
                            result.rssi
                    )

                    deviceList.addView(
                        Button(this@MainActivity).apply {
                            text =
                                advertisedName +
                                    "\n" +
                                    device.address +
                                    " (" +
                                    result.rssi +
                                    " dBm)"

                            setOnClickListener {
                                connect(
                                    device,
                                    advertisedName
                                )
                            }
                        }
                    )

                    val savedAddress =
                        prefs.getString(
                            "last_nus_address",
                            null
                        )

                    if (!autoConnectAttempted &&
                        savedAddress != null &&
                        savedAddress.equals(
                            device.address,
                            ignoreCase = true
                        )
                    ) {
                        autoConnectAttempted = true
                        appendLog(
                            "Known scooter found; auto-connecting."
                        )

                        connect(
                            device,
                            advertisedName
                        )
                    }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                runOnUiThread {
                    scanning = false
                    scanButton.text = "SCAN NOW"
                    setStatus("Scan failed")

                    appendLog(
                        "BLE scan failed with code " +
                            errorCode +
                            "."
                    )

                    scheduleRetry("Scan failure.")
                }
            }
        }

    private fun connect(
        device: BluetoothDevice,
        advertisedName: String
    ) {
        handler.removeCallbacks(retryScan)

        stopScan("Device selected; scan stopped.")
        resetSession()

        selectedBleName = advertisedName

        gatt?.close()

        setStatus(
            "Connecting to " +
                advertisedName
        )

        appendLog(
            "Connecting to " +
                device.address +
                " as " +
                advertisedName +
                "…"
        )

        gatt =
            device.connectGatt(
                this,
                false,
                gattCallback,
                BluetoothDevice.TRANSPORT_LE
            )
    }

    private fun resetSession() {
        handler.removeCallbacks(requestTimeout)
        handler.removeCallbacks(registerTimeout)

        state = SessionState.IDLE
        crypto = ClassicNbCrypto()
        negotiatedMtu = 23
        servicesStarted = false
        rxBuffer.reset()

        bleKey = ByteArray(0)
        scooterSerial = ByteArray(0)
        appKey = loadOrCreateAppKey()

        probeStep = 0
        lastConfirmedCounter = 0
        pingAttempts = 0
        pendingReadIndex = null
        speedReadQueue.clear()
        speedRaw.clear()

        writeChunks.clear()
        writeInProgress = false
        nusRx = null

        sport25Button.isEnabled = false
        sport32Button.isEnabled = false

        sport25Button.text = "25 km/h"
        sport32Button.text = "32 km/h"

        sportStatusView.text =
            "Waiting for classic session verification"
    }

    private fun loadOrCreateAppKey(): ByteArray {
        val saved =
            prefs.getString(
                "classic_app_key",
                null
            )

        if (saved != null) {
            val decoded =
                runCatching {
                    Base64.decode(
                        saved,
                        Base64.NO_WRAP
                    )
                }.getOrNull()

            if (decoded != null &&
                decoded.size == 16
            ) {
                return decoded
            }
        }

        val generated = ByteArray(16)
        SecureRandom().nextBytes(generated)

        prefs.edit()
            .putString(
                "classic_app_key",
                Base64.encodeToString(
                    generated,
                    Base64.NO_WRAP
                )
            )
            .apply()

        appendLog(
            "Generated persistent classic app key."
        )

        return generated
    }

    private val gattCallback =
        object : BluetoothGattCallback() {
            override fun onConnectionStateChange(
                g: BluetoothGatt,
                status: Int,
                newState: Int
            ) {
                handler.post {
                    if (status ==
                        BluetoothGatt.GATT_SUCCESS &&
                        newState ==
                        BluetoothProfile.STATE_CONNECTED
                    ) {
                        setStatus(
                            "Connected · negotiating MTU"
                        )

                        appendLog(
                            "Connected. Requesting MTU " + REQUEST_MTU + "."
                        )

                        val requested = g.requestMtu(REQUEST_MTU)
                        if (!requested) {
                            appendLog("MTU request could not start; discovering services.")
                            startServiceDiscovery(g)
                        } else {
                            handler.postDelayed({
                                if (!servicesStarted && gatt === g) {
                                    appendLog(
                                        "MTU callback timeout; discovering services with MTU " +
                                            negotiatedMtu + "."
                                    )
                                    startServiceDiscovery(g)
                                }
                            }, 1_000L)
                        }
                    } else if (
                        newState ==
                        BluetoothProfile.STATE_DISCONNECTED
                    ) {
                        appendLog(
                            "Disconnected. GATT status=" +
                                status +
                                "."
                        )

                        setStatus("Disconnected")
                        g.close()

                        if (gatt === g) {
                            gatt = null
                        }

                        scheduleRetry(
                            "Connection lost or failed."
                        )
                    } else {
                        appendLog(
                            "GATT state=" +
                                newState +
                                ", status=" +
                                status +
                                "."
                        )
                    }
                }
            }

            override fun onMtuChanged(
                g: BluetoothGatt,
                mtu: Int,
                status: Int
            ) {
                handler.post {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        negotiatedMtu = mtu
                        appendLog("✓ MTU negotiated: " + mtu + ".")
                    } else {
                        appendLog(
                            "MTU negotiation failed status=" + status +
                                "; using MTU " + negotiatedMtu + "."
                        )
                    }
                    startServiceDiscovery(g)
                }
            }

            override fun onServicesDiscovered(
                g: BluetoothGatt,
                status: Int
            ) {
                handler.post {
                    if (status !=
                        BluetoothGatt.GATT_SUCCESS
                    ) {
                        failSession(
                            "Service discovery failed: " +
                                status
                        )
                        return@post
                    }

                    logGattLayout(g)

                    val nus =
                        g.getService(
                            UUID_NUS_SERVICE
                        )

                    val tx =
                        nus?.getCharacteristic(
                            UUID_NUS_TX
                        )

                    val rx =
                        nus?.getCharacteristic(
                            UUID_NUS_RX
                        )

                    if (tx == null ||
                        rx == null
                    ) {
                        failSession(
                            "Nordic UART transport missing."
                        )
                        return@post
                    }

                    nusRx = rx

                    setStatus(
                        "Connected · enabling notifications"
                    )

                    val local =
                        g.setCharacteristicNotification(
                            tx,
                            true
                        )

                    appendLog(
                        "NUS local notification routing=" +
                            local
                    )

                    val cccd =
                        tx.getDescriptor(
                            UUID_CCCD
                        )

                    if (cccd == null) {
                        failSession(
                            "NUS TX CCCD missing."
                        )
                        return@post
                    }

                    val result =
                        if (Build.VERSION.SDK_INT >= 33) {
                            g.writeDescriptor(
                                cccd,
                                BluetoothGattDescriptor
                                    .ENABLE_NOTIFICATION_VALUE
                            )
                        } else {
                            @Suppress("DEPRECATION")
                            cccd.value =
                                BluetoothGattDescriptor
                                    .ENABLE_NOTIFICATION_VALUE

                            @Suppress("DEPRECATION")
                            if (g.writeDescriptor(cccd)) {
                                BluetoothStatusCodes.SUCCESS
                            } else {
                                BluetoothStatusCodes
                                    .ERROR_UNKNOWN
                            }
                        }

                    appendLog(
                        "Notification subscription request=" +
                            result
                    )
                }
            }

            override fun onDescriptorWrite(
                g: BluetoothGatt,
                descriptor: BluetoothGattDescriptor,
                status: Int
            ) {
                handler.post {
                    if (descriptor.uuid !=
                        UUID_CCCD
                    ) {
                        return@post
                    }

                    if (status ==
                        BluetoothGatt.GATT_SUCCESS
                    ) {
                        appendLog(
                            "✓ NUS TX notifications enabled."
                        )

                        beginClassicInit()
                    } else {
                        failSession(
                            "Notification subscription failed status=" +
                                status
                        )
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

                    if (status !=
                        BluetoothGatt.GATT_SUCCESS
                    ) {
                        writeChunks.clear()

                        failSession(
                            "NUS write chunk failed status=" +
                                status
                        )
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
                val value =
                    characteristic.value
                        ?: byteArrayOf()

                handler.post {
                    handleNotification(value)
                }
            }

            override fun onCharacteristicChanged(
                g: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray
            ) {
                handler.post {
                    handleNotification(value)
                }
            }
        }

    private fun startServiceDiscovery(g: BluetoothGatt) {
        if (servicesStarted) return
        servicesStarted = true
        setStatus("Connected · discovering services")
        appendLog("Discovering GATT services.")
        g.discoverServices()
    }

    private fun beginClassicInit() {
        crypto = ClassicNbCrypto()

        val nameBytes =
            selectedBleName
                .toByteArray(
                    Charsets.US_ASCII
                )

        crypto.setName(nameBytes)

        state = SessionState.INIT

        setStatus(
            "Classic INIT · " +
                selectedBleName
        )

        appendLog(
            "CLASSIC INIT · source=PC 0x3D · BLE=0x21 · key name=" +
                selectedBleName
        )

        val plain =
            buildPlainFrame(
                target = ES_BLE,
                command = CMD_INIT,
                index = 0,
                payload = byteArrayOf()
            )

        val encrypted =
            crypto.encrypt(plain)

        appendLog(
            "TX INIT encrypted · " +
                encrypted.size +
                " B · HEX [" +
                encrypted.toHex(" ") +
                "]"
        )

        enqueueGattFrame(encrypted)

        handler.removeCallbacks(
            pingRetry
        )

        handler.removeCallbacks(
            requestTimeout
        )

        handler.postDelayed(
            requestTimeout,
            REQUEST_TIMEOUT_MS
        )
    }

    private fun sendClassic(
        target: Int,
        command: Int,
        index: Int,
        payload: ByteArray
    ) {
        val plain =
            buildPlainFrame(
                target,
                command,
                index,
                payload
            )

        val encrypted =
            crypto.encrypt(plain)

        val redacted =
            command == CMD_PING

        appendLog(
            "TX classic src=0x" +
                hex2(PC) +
                " dst=0x" +
                hex2(target) +
                " cmd=0x" +
                hex2(command) +
                " idx=0x" +
                hex2(index) +
                " payload=" +
                payload.size +
                " B · enc=" +
                encrypted.size +
                " B" +
                if (redacted) " [key payload redacted]" else ""
        )

        enqueueGattFrame(encrypted)
    }

    private fun buildPlainFrame(
        target: Int,
        command: Int,
        index: Int,
        payload: ByteArray
    ): ByteArray =
        byteArrayOf(
            0x5A,
            0xA5.toByte(),
            payload.size.toByte(),
            PC.toByte(),
            target.toByte(),
            command.toByte(),
            index.toByte()
        ) + payload

    private fun enqueueGattFrame(
        frame: ByteArray
    ) {
        var offset = 0
        var chunks = 0

        while (offset < frame.size) {
            val end = minOf(offset + CLASSIC_CHUNK_SIZE, frame.size)
            writeChunks.add(frame.copyOfRange(offset, end))
            chunks += 1
            offset = end
        }

        appendLog(
            "NUS classic frame " + frame.size +
                " B -> " + chunks + " chunk(s) of max " +
                CLASSIC_CHUNK_SIZE + " B"
        )

        gatt?.let {
            drainWriteQueue(it)
        }
    }

    private fun drainWriteQueue(
        g: BluetoothGatt
    ) {
        if (writeInProgress) {
            return
        }

        val chunk =
            writeChunks.pollFirst()
                ?: return

        val rx =
            nusRx
                ?: return

        writeInProgress = true

        val started =
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(
                    rx,
                    chunk,
                    BluetoothGattCharacteristic
                        .WRITE_TYPE_DEFAULT
                ) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                rx.writeType =
                    BluetoothGattCharacteristic
                        .WRITE_TYPE_DEFAULT

                @Suppress("DEPRECATION")
                rx.value = chunk

                @Suppress("DEPRECATION")
                g.writeCharacteristic(rx)
            }

        appendLog(
            "NUS chunk write " +
                chunk.size +
                " B · started=" +
                started
        )

        if (!started) {
            writeInProgress = false
            writeChunks.clear()

            failSession(
                "Could not start NUS write."
            )
        }
    }

    private fun handleNotification(
        value: ByteArray
    ) {
        appendLog(
            "RX NUS RAW · " +
                packetSummary(value)
        )

        if (value.size >= 2 &&
            value[0] ==
            0x5A.toByte() &&
            value[1] ==
            0xA5.toByte()
        ) {
            rxBuffer.reset()
        }

        rxBuffer.write(value)
        processClassicRx()
    }

    private fun processClassicRx() {
        while (true) {
            val data =
                rxBuffer.toByteArray()

            if (data.size < 3) {
                return
            }

            if (data[0] !=
                0x5A.toByte() ||
                data[1] !=
                0xA5.toByte()
            ) {
                appendLog(
                    "Dropping non-classic RX buffer."
                )
                rxBuffer.reset()
                return
            }

            val totalEncrypted =
                (data[2].toInt() and 0xff) +
                    13

            if (data.size <
                totalEncrypted
            ) {
                return
            }

            val frame =
                data.copyOfRange(
                    0,
                    totalEncrypted
                )

            val remainder =
                data.copyOfRange(
                    totalEncrypted,
                    data.size
                )

            rxBuffer.reset()
            rxBuffer.write(remainder)

            val plain =
                runCatching {
                    crypto.decrypt(frame)
                }.getOrElse {
                    appendLog(
                        "Classic decrypt error: " +
                            (it.message
                                ?: it.javaClass.simpleName)
                    )
                    return
                }

            if (state == SessionState.PING && !isRecognizedClassicReply(plain)) {
                val counter =
                    ((frame[frame.size - 2].toInt() and 0xff) shl 8) or
                        (frame[frame.size - 1].toInt() and 0xff)

                appendLog(
                    "PING-era frame counter=" + counter +
                        " did not decode semantically; waiting for a valid PING/PAIR reply."
                )
                continue
            }

            appendClassicPlainLog(plain)
            handleClassicPacket(plain)
        }
    }

    private fun isRecognizedClassicReply(plain: ByteArray): Boolean {
        if (plain.size < 7 ||
            plain[0] != 0x5A.toByte() ||
            plain[1] != 0xA5.toByte()
        ) return false

        val source = plain[3].toInt() and 0xff
        val target = plain[4].toInt() and 0xff
        val command = plain[5].toInt() and 0xff

        return target == PC &&
            (source == ES_BLE || source == ES_CONTROL) &&
            (command == CMD_INIT ||
                command == CMD_PING ||
                command == CMD_PAIR ||
                command == CMD_READ_ACK)
    }

    private fun appendClassicPlainLog(
        plain: ByteArray
    ) {
        if (plain.size < 7) {
            appendLog(
                "RX classic malformed · " +
                    plain.toHex(" ")
            )
            return
        }

        val command =
            plain[5].toInt() and 0xff

        val payloadLength =
            plain[2].toInt() and 0xff

        val prefix =
            "RX classic src=0x" +
                hex2(
                    plain[3].toInt() and 0xff
                ) +
                " dst=0x" +
                hex2(
                    plain[4].toInt() and 0xff
                ) +
                " cmd=0x" +
                hex2(command) +
                " idx=0x" +
                hex2(
                    plain[6].toInt() and 0xff
                ) +
                " payload=" +
                payloadLength +
                " B"

        if (command == CMD_INIT ||
            command == CMD_PING
        ) {
            appendLog(
                prefix +
                    " [key material redacted]"
            )
        } else {
            appendLog(
                prefix +
                    " · " +
                    packetSummary(plain)
            )
        }
    }

    private fun handleClassicPacket(
        plain: ByteArray
    ) {
        if (plain.size < 7) {
            return
        }

        val payloadLength =
            plain[2].toInt() and 0xff

        if (plain.size <
            7 + payloadLength
        ) {
            return
        }

        val source =
            plain[3].toInt() and 0xff

        val target =
            plain[4].toInt() and 0xff

        val command =
            plain[5].toInt() and 0xff

        val index =
            plain[6].toInt() and 0xff

        val payload =
            plain.copyOfRange(
                7,
                7 + payloadLength
            )

        when {
            source == ES_BLE &&
                target == PC &&
                command == CMD_INIT -> {
                handleInitResponse(
                    payload
                )
            }

            source == ES_BLE &&
                target == PC &&
                command == CMD_PING -> {
                handlePingResponse(
                    index
                )
            }

            source == ES_BLE &&
                target == PC &&
                command == CMD_PAIR -> {
                appendLog(
                    "PAIR response idx=" +
                        index
                )
                if (index == 1 &&
                    state != SessionState.READY &&
                    state != SessionState.FAILED
                ) {
                    lastConfirmedCounter = crypto.iteration
                    appendLog(
                        "✓ PAIR acknowledged · counter=" + lastConfirmedCounter +
                            "; probing controller now."
                    )
                    handler.removeCallbacks(pingRetry)
                    handler.removeCallbacks(requestTimeout)
                    handler.removeCallbacks(registerTimeout)
                    pendingReadIndex = null
                    handler.postDelayed({ beginSessionProbe() }, 250L)
                }
            }

            source == ES_CONTROL &&
                target == PC &&
                command == CMD_READ_ACK -> {
                handleControllerRead(
                    index,
                    payload
                )
            }
        }
    }

    private fun handleInitResponse(
        payload: ByteArray
    ) {
        if (state !=
            SessionState.INIT
        ) {
            return
        }

        handler.removeCallbacks(
            requestTimeout
        )

        if (payload.size < 30) {
            failSession(
                "INIT response too short: " +
                    payload.size +
                    " B"
            )
            return
        }

        bleKey =
            payload.copyOfRange(
                0,
                16
            )

        scooterSerial =
            payload.copyOfRange(
                16,
                30
            )

        val serialText =
            scooterSerial
                .toString(
                    Charsets.US_ASCII
                )
                .replace(
                    "\u0000",
                    ""
                )
                .trim()

        appendLog(
            "✓ CLASSIC INIT accepted · BLE key 16 B · serial=" +
                serialText
        )

        crypto.setBleData(
            bleKey
        )

        gatt?.device?.let { device ->
            prefs.edit()
                .putString("last_nus_address", device.address)
                .putString("last_advertised_name", selectedBleName)
                .apply()
        }

        state = SessionState.PING
        pingAttempts = 0

        setStatus(
            "Classic PING · pairing/session check"
        )

        handler.removeCallbacks(pingRetry)
        handler.removeCallbacks(requestTimeout)
        handler.post(pingRetry)
        handler.postDelayed(
            requestTimeout,
            REQUEST_TIMEOUT_MS
        )
    }

    private fun handlePingResponse(
        index: Int
    ) {
        if (state != SessionState.PING &&
            state != SessionState.PROBING
        ) {
            return
        }

        handler.removeCallbacks(pingRetry)
        handler.removeCallbacks(requestTimeout)
        handler.removeCallbacks(registerTimeout)
        pendingReadIndex = null

        lastConfirmedCounter = crypto.iteration

        appendLog(
            "✓ CLASSIC PING response · index=" + index +
                " · counter=" + lastConfirmedCounter +
                if (state == SessionState.PROBING) " · accepted late during probe" else ""
        )

        if (index == 1) {
            appendLog(
                "PING confirms the app key/session. Probing controller directly; final PAIR is unnecessary."
            )
            handler.postDelayed(
                { beginSessionProbe() },
                250L
            )
            return
        }

        appendLog(
            "PING index=0: scooter is not paired with this app key yet."
        )
        sportStatusView.text =
            "Pairing required. Press the scooter power button once."

        toast("Press the scooter power button once to pair")

        if (scooterSerial.isNotEmpty()) {
            sendClassic(
                target = ES_BLE,
                command = CMD_PAIR,
                index = 0,
                payload = scooterSerial
            )
        }

        state = SessionState.PING
        handler.postDelayed(pingRetry, PING_RETRY_MS)
        handler.postDelayed(requestTimeout, REQUEST_TIMEOUT_MS)
    }

    private fun beginSessionProbe() {
        state =
            SessionState.PROBING

        probeStep = 0

        if (lastConfirmedCounter <= 0) {
            failSession("Cannot probe session without a confirmed encrypted counter.")
            return
        }

        setStatus(
            "Testing classic encrypted session…"
        )

        sportStatusView.text =
            "INIT/PING succeeded. Testing controller read…"

        probeCurrentSession()
    }

    private fun probeCurrentSession() {
        rxBuffer.reset()

        when (probeStep) {
            0 -> {
                crypto.setBleData(bleKey)
                crypto.setIteration(lastConfirmedCounter)
            }
            1 -> {
                crypto.setAppData(appKey)
                crypto.setIteration(lastConfirmedCounter)
            }
            else -> {
                crypto.setBleData(bleKey)
                crypto.setIteration(lastConfirmedCounter)
            }
        }

        val label =
            when (probeStep) {
                0 ->
                    "name + BLE key"

                1 ->
                    "app key + BLE key"

                else ->
                    "name + BLE key retry"
            }

        appendLog(
            "SESSION probe " +
                (probeStep + 1) +
                "/3 · derivation=" +
                label +
                " · counter=" + crypto.iteration +
                " · READ 0x1A"
        )

        pendingReadIndex =
            REG_FIRMWARE

        sendClassic(
            target = ES_CONTROL,
            command = CMD_READ,
            index = REG_FIRMWARE,
            payload = byteArrayOf(2)
        )

        handler.removeCallbacks(
            requestTimeout
        )

        handler.postDelayed(
            requestTimeout,
            REQUEST_TIMEOUT_MS
        )
    }

    private fun tryNextSessionKey() {
        handler.removeCallbacks(
            requestTimeout
        )

        pendingReadIndex = null

        probeStep += 1

        when (probeStep) {
            1 -> {
                appendLog(
                    "Session read silent; switching to app+BLE derivation."
                )

                handler.postDelayed(
                    { probeCurrentSession() },
                    250L
                )
            }

            2 -> {
                appendLog(
                    "App+BLE silent; switching back to name+BLE derivation."
                )

                handler.postDelayed(
                    { probeCurrentSession() },
                    250L
                )
            }

            else -> {
                failSession(
                    "INIT/PING worked, but all encrypted controller-read derivations were silent."
                )
            }
        }
    }

    private fun handleControllerRead(
        index: Int,
        payload: ByteArray
    ) {
        if (payload.size < 2) {
            appendLog(
                "Controller READ 0x" +
                    hex2(index) +
                    " returned " +
                    payload.size +
                    " B"
            )
            return
        }

        if (state ==
            SessionState.PROBING &&
            index ==
            REG_FIRMWARE
        ) {
            handler.removeCallbacks(
                requestTimeout
            )

            pendingReadIndex = null
            state = SessionState.READY

            val raw =
                littleEndian16(
                    payload
                )

            appendLog(
                "✓ Encrypted controller read works · firmware raw=0x" +
                    raw.toString(16)
                        .padStart(4, '0')
                        .uppercase() +
                    " · derivation " +
                    (probeStep + 1) +
                    "/3"
            )

            setStatus(
                "✓ Classic encrypted session verified"
            )

            sportStatusView.text =
                "Session verified. Reading speed registers 0x72–0x75…"

            beginSpeedRead()
            return
        }

        if (state ==
            SessionState.READY &&
            pendingReadIndex ==
            index
        ) {
            handler.removeCallbacks(
                registerTimeout
            )

            val raw =
                littleEndian16(
                    payload
                )

            speedRaw[index] = raw

            logSpeedRegister(
                index,
                raw
            )

            pendingReadIndex = null
            readNextSpeedRegister()
        }
    }

    private fun beginSpeedRead() {
        speedReadQueue.clear()
        speedRaw.clear()

        speedReadQueue.add(
            REG_LIMIT_RELEASE
        )
        speedReadQueue.add(
            REG_NORMAL_SPEED
        )
        speedReadQueue.add(
            REG_LIMITED_SPEED
        )
        speedReadQueue.add(
            REG_WORK_MODE
        )

        readNextSpeedRegister()
    }

    private fun readNextSpeedRegister() {
        if (state !=
            SessionState.READY
        ) {
            return
        }

        if (pendingReadIndex != null) {
            return
        }

        val index =
            speedReadQueue.pollFirst()
                ?: run {
                    finishSpeedRead()
                    return
                }

        pendingReadIndex = index

        appendLog(
            "READ controller 0x" +
                hex2(index) +
                " len=2"
        )

        sendClassic(
            target = ES_CONTROL,
            command = CMD_READ,
            index = index,
            payload = byteArrayOf(2)
        )

        handler.removeCallbacks(
            registerTimeout
        )

        handler.postDelayed(
            registerTimeout,
            REGISTER_TIMEOUT_MS
        )
    }

    private fun logSpeedRegister(
        index: Int,
        rawUnsigned: Int
    ) {
        val signed =
            signed16(
                rawUnsigned
            )

        val interpretation =
            when (index) {
                REG_LIMIT_RELEASE ->
                    " ≈ " +
                        formatNumber(
                            signed / 10.0
                        ) +
                        " km/h"

                REG_NORMAL_SPEED ->
                    " ≈ " +
                        formatNumber(
                            signed / 1000.0
                        ) +
                        " km/h"

                REG_LIMITED_SPEED ->
                    " ≈ " +
                        formatNumber(
                            signed / 10.0
                        ) +
                        " km/h"

                REG_WORK_MODE ->
                    " · modeRaw=" +
                        rawUnsigned

                else -> ""
            }

        appendLog(
            "SPEED REG 0x" +
                hex2(index) +
                " raw=" +
                signed +
                " hex=0x" +
                rawUnsigned
                    .toString(16)
                    .padStart(4, '0')
                    .uppercase() +
                " bytes=[" +
                hex2(
                    rawUnsigned and
                        0xff
                ) +
                " " +
                hex2(
                    (rawUnsigned shr 8) and
                        0xff
                ) +
                "]" +
                interpretation
        )
    }

    private fun finishSpeedRead() {
        val summary =
            speedRaw.entries
                .joinToString(
                    " · "
                ) {
                    "0x" +
                        hex2(it.key) +
                        "=0x" +
                        it.value
                            .toString(16)
                            .padStart(4, '0')
                            .uppercase()
                }

        appendLog(
            "✓ CLASSIC SPEED MAP " +
                summary
        )

        setStatus(
            "✓ Session verified · speed map captured"
        )

        sportStatusView.text =
            "✓ 0x72–0x75 captured. Copy/send trace; writes stay disabled in r9."

        toast(
            "✓ Speed map captured"
        )
    }

    private fun littleEndian16(
        payload: ByteArray
    ): Int =
        (payload[0].toInt() and 0xff) or
            ((payload[1].toInt() and 0xff) shl 8)

    private fun signed16(
        value: Int
    ): Int =
        if (value and 0x8000 != 0) {
            value - 0x10000
        } else {
            value
        }

    private fun formatNumber(
        value: Double
    ): String =
        if (abs(
                value -
                    value.toInt()
            ) < 0.001
        ) {
            value.toInt().toString()
        } else {
            String.format(
                Locale.US,
                "%.1f",
                value
            )
        }

    private fun failSession(
        reason: String
    ) {
        handler.removeCallbacks(
            requestTimeout
        )

        handler.removeCallbacks(
            registerTimeout
        )

        state =
            SessionState.FAILED

        pendingReadIndex = null

        setStatus(
            "Protocol error"
        )

        sportStatusView.text =
            reason

        appendLog(
            "CLASSIC FAIL: " +
                reason
        )
    }

    private fun logGattLayout(
        g: BluetoothGatt
    ) {
        val out =
            StringBuilder(
                "GATT services discovered:"
            )

        for (service in
            g.services
        ) {
            out.append("\nSERVICE ")
                .append(
                    service.uuid
                )

            for (characteristic in
                service.characteristics
            ) {
                out.append("\n  ")
                    .append(
                        characteristic.uuid
                    )
                    .append(" props=")
                    .append(
                        characteristic.properties
                    )
                    .append(" [")
                    .append(
                        propertyNames(
                            characteristic.properties
                        )
                    )
                    .append("]")
            }
        }

        appendLog(
            out.toString()
        )
    }

    private fun packetSummary(
        value: ByteArray
    ): String {
        val ascii =
            buildString {
                value.forEach { byte ->
                    val c =
                        byte.toInt() and
                            0xff

                    append(
                        if (c in 32..126) {
                            c.toChar()
                        } else {
                            '.'
                        }
                    )
                }
            }

        return value.size.toString() +
            " B · HEX [" +
            value.toHex(" ") +
            "] · ASCII [" +
            ascii +
            "]"
    }

    private fun ByteArray.toHex(
        separator: String = ""
    ): String =
        joinToString(
            separator
        ) {
            "%02X".format(
                it.toInt() and
                    0xff
            )
        }

    private fun hex2(
        value: Int
    ): String =
        value
            .toString(16)
            .padStart(2, '0')
            .uppercase()

    private fun propertyNames(
        properties: Int
    ): String {
        val names =
            mutableListOf<String>()

        if (properties and
            BluetoothGattCharacteristic
                .PROPERTY_READ != 0
        ) {
            names += "READ"
        }

        if (properties and
            BluetoothGattCharacteristic
                .PROPERTY_WRITE != 0
        ) {
            names += "WRITE"
        }

        if (properties and
            BluetoothGattCharacteristic
                .PROPERTY_WRITE_NO_RESPONSE != 0
        ) {
            names += "WRITE_NR"
        }

        if (properties and
            BluetoothGattCharacteristic
                .PROPERTY_NOTIFY != 0
        ) {
            names += "NOTIFY"
        }

        if (properties and
            BluetoothGattCharacteristic
                .PROPERTY_INDICATE != 0
        ) {
            names += "INDICATE"
        }

        return if (names.isEmpty()) {
            "-"
        } else {
            names.joinToString("|")
        }
    }

    private fun setStatus(
        text: String
    ) {
        statusView.text = text
    }

    private fun appendLog(
        message: String
    ) {
        val time =
            SimpleDateFormat(
                "HH:mm:ss.SSS",
                Locale.US
            ).format(
                Date()
            )

        if (trace.isNotEmpty()) {
            trace.append('\n')
        }

        trace.append('[')
            .append(time)
            .append("] ")
            .append(message)

        logView.text =
            trace.toString()

        logBody.post {
            logBody.fullScroll(
                View.FOCUS_DOWN
            )
        }
    }

    private fun toast(
        text: String
    ) {
        Toast.makeText(
            this,
            text,
            Toast.LENGTH_LONG
        ).show()
    }

    override fun onDestroy() {
        handler.removeCallbacks(
            retryScan
        )

        handler.removeCallbacks(
            stopScanAfterTimeout
        )

        handler.removeCallbacks(
            requestTimeout
        )

        handler.removeCallbacks(
            registerTimeout
        )

        if (scanning) {
            scanner?.stopScan(
                scanCallback
            )
        }

        gatt?.close()

        super.onDestroy()
    }
}

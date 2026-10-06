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
import com.example.ninebote3.protocol.NinebotCryptoV2
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.UUID

class MainActivity : Activity() {
    companion object {
        private const val BUILD_ID = "r8-x3-encryption2"
        private const val PERMISSION_REQUEST = 10
        private const val SCAN_DURATION_MS = 10_000L
        private const val RETRY_DEBOUNCE_MS = 2_000L
        private const val HANDSHAKE_TIMEOUT_MS = 3_000L
        private const val PAIR_RETRY_MS = 2_500L
        private const val REGISTER_TIMEOUT_MS = 2_500L
        private const val REQUEST_MTU = 185

        private val UUID_NUS_SERVICE = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_RX = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_NUS_TX = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
        private val UUID_CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private val UUID_GAP_SERVICE = UUID.fromString("00001800-0000-1000-8000-00805f9b34fb")
        private val UUID_DEVICE_NAME = UUID.fromString("00002a00-0000-1000-8000-00805f9b34fb")

        private const val BT_ID = 0x3E
        private const val BOARD_BLE = 0x04
        private const val BOARD_VCU = 0x16

        private const val CMD_READ = 0x01
        private const val CMD_READ_RESP = 0x04
        private const val CMD_PRE_COMM = 0x5B
        private const val CMD_SET_PWD = 0x5C
        private const val CMD_AUTH = 0x5D
    }

    private enum class SessionState {
        IDLE,
        PRECOMM,
        PAIRING,
        AUTH,
        AUTHENTICATED,
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
    private val prefs by lazy { getSharedPreferences("ninebot", MODE_PRIVATE) }
    private val trace = StringBuilder()
    private val found = linkedMapOf<String, BluetoothDevice>()

    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var gatt: BluetoothGatt? = null
    private var nusRx: BluetoothGattCharacteristic? = null
    private var servicesStarted = false
    private var negotiatedMtu = 23
    private var autoConnectAttempted = false

    private var deviceName = ""
    private var sessionState = SessionState.IDLE
    private var crypto = NinebotCryptoV2(gen2 = true)
    private val rxBuffer = ByteArrayOutputStream()

    private var authParam = ByteArray(0)
    private var scooterSerial = ""
    private var pairingCandidate: ByteArray? = null
    private var pairingPromptShown = false

    private val registerQueue = ArrayDeque<Int>()
    private var pendingRegister: Int? = null
    private val speedRegisterMap = linkedMapOf<Int, Int>()

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

    private val handshakeTimeout = Runnable {
        when (sessionState) {
            SessionState.PRECOMM -> failSession(
                "No PRE_COMM response. E3 x3 handshake not accepted."
            )
            SessionState.AUTH -> failSession(
                "AUTH timed out. Stored pairing password may be wrong."
            )
            else -> Unit
        }
    }

    private val pairRetry = object : Runnable {
        override fun run() {
            if (sessionState != SessionState.PAIRING) return

            if (!pairingPromptShown) {
                pairingPromptShown = true
                setStatus("Pairing · press scooter power button once")
                toast("Press the scooter power button once to confirm pairing")
            }

            appendLog("PAIR retry: SET_PWD")
            sendSetPassword()
            handler.postDelayed(this, PAIR_RETRY_MS)
        }
    }

    private val registerTimeout = Runnable {
        val index = pendingRegister ?: return@Runnable
        appendLog("VCU READ timeout idx=0x" + hex2(index))
        pendingRegister = null
        readNextSpeedRegister()
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
            text = "Ninebot E3 Pro Controller · r8"
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
            text = "Authenticating x3 controller first"
            setPadding(0, dp(4), 0, dp(8))
        }
        root.addView(sportStatusView)

        root.addView(TextView(this).apply {
            text = "r8 is read-only after authentication: it captures the E3 speed map before enabling writes."
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
                dp(320)
            )
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
        clipboard.setPrimaryClip(
            ClipData.newPlainText("Ninebot BLE trace", trace.toString())
        )
        toast("Trace copied")
    }

    private fun ensurePermissionsAndAutoScan() {
        if (Build.VERSION.SDK_INT >= 31) {
            val scanGranted =
                checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) ==
                    PackageManager.PERMISSION_GRANTED
            val connectGranted =
                checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
                    PackageManager.PERMISSION_GRANTED

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
        results: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != PERMISSION_REQUEST) return

        if (results.isNotEmpty() &&
            results.all { it == PackageManager.PERMISSION_GRANTED }
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
            checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            ensurePermissionsAndAutoScan()
            return
        }

        val adapter =
            (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter

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
        appendLog(
            reason + " Retry scheduled in " + RETRY_DEBOUNCE_MS + " ms."
        )
        handler.postDelayed(retryScan, RETRY_DEBOUNCE_MS)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) {
            runOnUiThread {
                val device = result.device
                if (found.containsKey(device.address)) return@runOnUiThread

                found[device.address] = device
                val name = device.name ?: "Unknown BLE device"

                appendLog(
                    "Found: " + name + " / " + device.address +
                        " / RSSI " + result.rssi
                )

                deviceList.addView(Button(this@MainActivity).apply {
                    text =
                        name + "\n" + device.address +
                            " (" + result.rssi + " dBm)"
                    setOnClickListener { connect(device) }
                })

                val savedAddress =
                    prefs.getString("last_nus_address", null)

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
        resetSession()
        gatt?.close()

        deviceName = device.name ?: ""
        setStatus("Connecting to " + (device.name ?: device.address))
        appendLog("Connecting to " + device.address + "…")

        gatt = device.connectGatt(
            this,
            false,
            gattCallback,
            BluetoothDevice.TRANSPORT_LE
        )
    }

    private fun resetSession() {
        handler.removeCallbacks(handshakeTimeout)
        handler.removeCallbacks(pairRetry)
        handler.removeCallbacks(registerTimeout)

        servicesStarted = false
        negotiatedMtu = 23
        nusRx = null
        sessionState = SessionState.IDLE
        crypto = NinebotCryptoV2(gen2 = true)
        rxBuffer.reset()
        authParam = ByteArray(0)
        scooterSerial = ""
        pairingCandidate = null
        pairingPromptShown = false
        registerQueue.clear()
        speedRegisterMap.clear()
        pendingRegister = null

        sport25Button.isEnabled = false
        sport32Button.isEnabled = false
        sportStatusView.text = "Authenticating x3 controller first"
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(
            g: BluetoothGatt,
            status: Int,
            newState: Int
        ) {
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS &&
                    newState == BluetoothProfile.STATE_CONNECTED
                ) {
                    appendLog("Connected. Requesting MTU " + REQUEST_MTU + ".")
                    setStatus("Connected · negotiating MTU")

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
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    appendLog("Disconnected. GATT status=" + status + ".")
                    setStatus("Disconnected")
                    g.close()
                    if (gatt === g) gatt = null
                    scheduleRetry("Connection lost or failed.")
                } else {
                    appendLog(
                        "GATT state=" + newState + ", status=" + status + "."
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
                            "; using " + negotiatedMtu + "."
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
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    appendLog("Service discovery failed: " + status + ".")
                    setStatus("Service discovery failed")
                    return@post
                }

                logGattLayout(g)

                val nus = g.getService(UUID_NUS_SERVICE)
                val tx = nus?.getCharacteristic(UUID_NUS_TX)
                val rx = nus?.getCharacteristic(UUID_NUS_RX)

                if (tx == null || rx == null) {
                    failSession("Nordic UART transport not found.")
                    return@post
                }

                nusRx = rx

                prefs.edit()
                    .putString("last_nus_address", g.device.address)
                    .putString("last_nus_name", g.device.name)
                    .apply()

                val nameChar =
                    g.getService(UUID_GAP_SERVICE)
                        ?.getCharacteristic(UUID_DEVICE_NAME)

                if (nameChar != null &&
                    nameChar.properties and
                    BluetoothGattCharacteristic.PROPERTY_READ != 0
                ) {
                    appendLog("Reading GATT device name for Encryption2 key.")
                    if (!g.readCharacteristic(nameChar)) {
                        appendLog("GATT name read could not start; using scan name.")
                        enableNotifications(g, tx)
                    }
                } else {
                    appendLog("GATT name unavailable; using scan name.")
                    enableNotifications(g, tx)
                }
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            val value = characteristic.value ?: byteArrayOf()
            handler.post {
                handleCharacteristicRead(g, characteristic, value, status)
            }
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            handler.post {
                handleCharacteristicRead(g, characteristic, value, status)
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
                    beginPreComm()
                } else {
                    failSession(
                        "Notification subscription failed status=" + status
                    )
                }
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

    private fun startServiceDiscovery(g: BluetoothGatt) {
        if (servicesStarted) return
        servicesStarted = true
        setStatus("Connected · discovering services")
        appendLog("Discovering GATT services.")
        g.discoverServices()
    }

    private fun handleCharacteristicRead(
        g: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int
    ) {
        if (characteristic.uuid == UUID_DEVICE_NAME &&
            status == BluetoothGatt.GATT_SUCCESS
        ) {
            val exactName =
                value.toString(Charsets.US_ASCII)
                    .replace("\u0000", "")
                    .trim()

            if (exactName.isNotBlank()) {
                deviceName = exactName
                appendLog("IDENT GATT Device Name = " + deviceName)
            }
        } else if (characteristic.uuid == UUID_DEVICE_NAME) {
            appendLog(
                "GATT device name read failed status=" + status +
                    "; using scan name " + deviceName
            )
        }

        val tx =
            g.getService(UUID_NUS_SERVICE)
                ?.getCharacteristic(UUID_NUS_TX)

        if (tx != null) {
            enableNotifications(g, tx)
        } else {
            failSession("NUS TX characteristic disappeared.")
        }
    }

    private fun enableNotifications(
        g: BluetoothGatt,
        tx: BluetoothGattCharacteristic
    ) {
        setStatus("Connected · enabling x3 notifications")

        val local = g.setCharacteristicNotification(tx, true)
        appendLog("NUS local notification routing=" + local)

        val cccd = tx.getDescriptor(UUID_CCCD)
        if (cccd == null) {
            failSession("NUS TX CCCD missing.")
            return
        }

        val result =
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeDescriptor(
                    cccd,
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                )
            } else {
                @Suppress("DEPRECATION")
                cccd.value =
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE

                @Suppress("DEPRECATION")
                if (g.writeDescriptor(cccd)) {
                    BluetoothStatusCodes.SUCCESS
                } else {
                    BluetoothStatusCodes.ERROR_UNKNOWN
                }
            }

        appendLog("Notification subscription request=" + result)
    }

    private fun beginPreComm() {
        if (deviceName.isBlank()) {
            deviceName =
                prefs.getString("last_nus_name", null) ?: "Ninebot"
        }

        crypto = NinebotCryptoV2(gen2 = true)
        crypto.resetSn()
        crypto.setKey(
            deviceName.toByteArray(Charsets.US_ASCII),
            NinebotCryptoV2.FW_DATA
        )

        sessionState = SessionState.PRECOMM
        setStatus("x3 PRE_COMM · " + deviceName)
        appendLog(
            "X3 PRE_COMM gen2 · key name=" + deviceName +
                " · BLE board=0x04"
        )

        sendFrame(
            target = BOARD_BLE,
            command = CMD_PRE_COMM,
            index = 0,
            payload = byteArrayOf()
        )

        handler.removeCallbacks(handshakeTimeout)
        handler.postDelayed(handshakeTimeout, HANDSHAKE_TIMEOUT_MS)
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
            BT_ID.toByte(),
            target.toByte(),
            command.toByte(),
            index.toByte()
        ) + payload

    private fun sendFrame(
        target: Int,
        command: Int,
        index: Int,
        payload: ByteArray
    ): Boolean {
        val plain =
            buildPlainFrame(target, command, index, payload)
        val encrypted = crypto.encrypt(plain)

        appendLog(
            "TX X3 plain " + shortFrame(plain) +
                " -> ENC " + encrypted.size + " B [" +
                encrypted.toHex() + "]"
        )

        return writeWholeFrame(encrypted)
    }

    private fun writeWholeFrame(frame: ByteArray): Boolean {
        val g = gatt ?: return false
        val rx = nusRx ?: return false

        val maxPayload = negotiatedMtu - 3
        if (frame.size > maxPayload) {
            failSession(
                "Frame is " + frame.size + " B but MTU " +
                    negotiatedMtu + " only carries " + maxPayload +
                    " B. Authentication frame cannot be split."
            )
            return false
        }

        val writeType =
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE

        val started =
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(rx, frame, writeType) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                rx.writeType = writeType

                @Suppress("DEPRECATION")
                rx.value = frame

                @Suppress("DEPRECATION")
                g.writeCharacteristic(rx)
            }

        appendLog(
            "NUS write whole frame · " + frame.size +
                " B · MTU " + negotiatedMtu +
                " · started=" + started
        )

        return started
    }

    private fun handleNotification(value: ByteArray) {
        appendLog("RX NUS RAW · " + packetSummary(value))
        rxBuffer.write(value)
        processRxBuffer()
    }

    private fun processRxBuffer() {
        while (true) {
            var data = rxBuffer.toByteArray()

            val startA5 = findSync(data, 0xA5)
            val startB5 = findSync(data, 0xB5)
            val start =
                listOf(startA5, startB5)
                    .filter { it >= 0 }
                    .minOrNull() ?: run {
                    if (data.isNotEmpty() &&
                        data.last() == 0x5A.toByte()
                    ) {
                        rxBuffer.reset()
                        rxBuffer.write(byteArrayOf(0x5A))
                    } else {
                        rxBuffer.reset()
                    }
                    return
                }

            if (start > 0) {
                data = data.copyOfRange(start, data.size)
                rxBuffer.reset()
                rxBuffer.write(data)
            }

            if (data.size < 3) return

            val total =
                (data[2].toInt() and 0xff) + 13

            if (data.size < total) return

            val frame = data.copyOfRange(0, total)
            val remainder =
                data.copyOfRange(total, data.size)

            rxBuffer.reset()
            rxBuffer.write(remainder)

            val (plain, status) = crypto.decrypt(frame)

            if (status != NinebotCryptoV2.SUCCESS) {
                appendLog(
                    "X3 decrypt failed status=" + status +
                        " · " + frame.toHex()
                )

                if (sessionState == SessionState.PAIRING) {
                    sportStatusView.text =
                        "Pair reply used another key — scooter may still be bound"
                }
                continue
            }

            appendLog("RX X3 plain · " + packetSummary(plain))
            handlePlainFrame(plain)
        }
    }

    private fun findSync(data: ByteArray, sync2: Int): Int {
        for (i in 0 until data.size - 1) {
            if (data[i] == 0x5A.toByte() &&
                data[i + 1] == sync2.toByte()
            ) {
                return i
            }
        }
        return -1
    }

    private fun handlePlainFrame(plain: ByteArray) {
        if (plain.size < 7 ||
            plain[0] != 0x5A.toByte()
        ) {
            appendLog("Malformed X3 plaintext frame.")
            return
        }

        val length = plain[2].toInt() and 0xff
        val source = plain[3].toInt() and 0xff
        val destination = plain[4].toInt() and 0xff
        val command = plain[5].toInt() and 0xff
        val index = plain[6].toInt() and 0xff
        val available =
            minOf(length, maxOf(0, plain.size - 7))
        val payload =
            plain.copyOfRange(7, 7 + available)

        appendLog(
            "X3 src=0x" + hex2(source) +
                " dst=0x" + hex2(destination) +
                " cmd=0x" + hex2(command) +
                " idx=0x" + hex2(index) +
                " len=" + payload.size
        )

        when {
            source == BOARD_BLE &&
                destination == BT_ID &&
                command == CMD_PRE_COMM -> {
                handlePreComm(index, payload)
            }

            source == BOARD_BLE &&
                destination == BT_ID &&
                command == CMD_SET_PWD -> {
                handleSetPassword(index)
            }

            source == BOARD_BLE &&
                destination == BT_ID &&
                command == CMD_AUTH -> {
                handleAuth(index)
            }

            source == BOARD_VCU &&
                destination == BT_ID &&
                command == CMD_READ_RESP -> {
                handleVcuRead(index, payload)
            }
        }
    }

    private fun handlePreComm(
        index: Int,
        payload: ByteArray
    ) {
        handler.removeCallbacks(handshakeTimeout)

        if (payload.size < 30) {
            failSession(
                "PRE_COMM response too short: " + payload.size + " B"
            )
            return
        }

        authParam = payload.copyOfRange(0, 16)
        scooterSerial =
            payload.copyOfRange(16, 30)
                .toString(Charsets.US_ASCII)
                .replace("\u0000", "")
                .trim()

        appendLog(
            "✓ X3 PRE_COMM accepted · serial=" + scooterSerial +
                " · storedPassword=" + (index != 0)
        )

        crypto.setAuth(authParam)
        crypto.startSn()
        rxBuffer.reset()

        val saved =
            prefs.getString("v2_password", null)
                ?.let {
                    runCatching {
                        Base64.decode(it, Base64.NO_WRAP)
                    }.getOrNull()
                }
                ?.takeIf { it.size == 16 }

        if (saved != null && index != 0) {
            appendLog("Using persisted x3 pairing password.")
            crypto.setKey(saved, authParam)
            sendAuth()
            return
        }

        crypto.setKey(
            deviceName.toByteArray(Charsets.US_ASCII),
            authParam
        )

        pairingCandidate =
            ByteArray(16).also {
                SecureRandom().nextBytes(it)
            }

        sessionState = SessionState.PAIRING
        pairingPromptShown = false

        if (index != 0) {
            setStatus("Scooter already paired · trying new pairing")
            sportStatusView.text =
                "Already paired. If pairing is refused, unbind it from the Segway app."
            appendLog(
                "Device reports an existing pairing; a new SET_PWD may be refused."
            )
        } else {
            setStatus("Pairing · press scooter power button once")
            sportStatusView.text =
                "Press the scooter power button once to confirm pairing"
        }

        sendSetPassword()
        handler.removeCallbacks(pairRetry)
        handler.postDelayed(pairRetry, PAIR_RETRY_MS)
    }

    private fun sendSetPassword() {
        val password = pairingCandidate ?: return

        if (negotiatedMtu - 3 < 29) {
            failSession(
                "MTU " + negotiatedMtu +
                    " is too small for the 29-byte pairing frame."
            )
            return
        }

        sendFrame(
            target = BOARD_BLE,
            command = CMD_SET_PWD,
            index = 0,
            payload = password
        )
    }

    private fun handleSetPassword(index: Int) {
        if (sessionState != SessionState.PAIRING) return

        if (index != 1) {
            appendLog("SET_PWD pending/rejected idx=" + index)
            return
        }

        handler.removeCallbacks(pairRetry)

        val password = pairingCandidate
        if (password == null) {
            failSession("Pairing confirmed but password candidate is missing.")
            return
        }

        prefs.edit()
            .putString(
                "v2_password",
                Base64.encodeToString(password, Base64.NO_WRAP)
            )
            .apply()

        appendLog("✓ X3 pairing password confirmed and persisted.")
        crypto.setKey(password, authParam)
        sendAuth()
    }

    private fun sendAuth() {
        sessionState = SessionState.AUTH
        setStatus("Authenticating x3 session…")

        val serialPayload =
            scooterSerial.toByteArray(Charsets.US_ASCII)
                .copyOf(14)

        sendFrame(
            target = BOARD_BLE,
            command = CMD_AUTH,
            index = 0,
            payload = serialPayload
        )

        handler.removeCallbacks(handshakeTimeout)
        handler.postDelayed(
            handshakeTimeout,
            HANDSHAKE_TIMEOUT_MS + 1_000L
        )
    }

    private fun handleAuth(index: Int) {
        handler.removeCallbacks(handshakeTimeout)

        if (index != 1) {
            prefs.edit().remove("v2_password").apply()
            failSession("X3 AUTH rejected idx=" + index)
            return
        }

        sessionState = SessionState.AUTHENTICATED
        appendLog("✓ X3 Encryption2 authenticated.")
        setStatus("✓ Authenticated · reading E3 speed map")
        sportStatusView.text =
            "Authenticated. Reading VCU 0x43–0x48…"

        beginSpeedMapRead()
    }

    private fun beginSpeedMapRead() {
        registerQueue.clear()
        speedRegisterMap.clear()
        pendingRegister = null

        for (index in 0x43..0x48) {
            registerQueue.add(index)
        }

        readNextSpeedRegister()
    }

    private fun readNextSpeedRegister() {
        if (sessionState != SessionState.AUTHENTICATED) return
        if (pendingRegister != null) return

        val index =
            registerQueue.pollFirst() ?: run {
                finishSpeedMapRead()
                return
            }

        pendingRegister = index
        appendLog("READ VCU idx=0x" + hex2(index) + " len=2")

        sendFrame(
            target = BOARD_VCU,
            command = CMD_READ,
            index = index,
            payload = byteArrayOf(2)
        )

        handler.removeCallbacks(registerTimeout)
        handler.postDelayed(
            registerTimeout,
            REGISTER_TIMEOUT_MS
        )
    }

    private fun handleVcuRead(
        index: Int,
        payload: ByteArray
    ) {
        if (payload.size < 2) {
            appendLog(
                "VCU 0x" + hex2(index) +
                    " short response " + payload.size + " B"
            )
            return
        }

        val raw =
            (payload[0].toInt() and 0xff) or
                ((payload[1].toInt() and 0xff) shl 8)

        speedRegisterMap[index] = raw

        appendLog(
            "VCU 0x" + hex2(index) +
                " raw=" + raw +
                " hex=0x" + raw.toString(16).padStart(4, '0').uppercase() +
                " bytes=[" +
                hex2(payload[0].toInt() and 0xff) + " " +
                hex2(payload[1].toInt() and 0xff) + "]"
        )

        if (pendingRegister == index) {
            handler.removeCallbacks(registerTimeout)
            pendingRegister = null
            readNextSpeedRegister()
        }
    }

    private fun finishSpeedMapRead() {
        val summary =
            speedRegisterMap.entries.joinToString(" · ") {
                "0x" + hex2(it.key) +
                    "=[" + hex2(it.value and 0xff) +
                    " " + hex2((it.value shr 8) and 0xff) + "]"
            }

        appendLog("✓ E3 SPEED MAP " + summary)
        setStatus("✓ Authenticated · speed map captured")
        sportStatusView.text =
            "✓ Speed map captured. Copy/send trace; writes remain disabled in r8."
        toast("✓ E3 speed map captured")
    }

    private fun failSession(reason: String) {
        handler.removeCallbacks(handshakeTimeout)
        handler.removeCallbacks(pairRetry)
        handler.removeCallbacks(registerTimeout)

        sessionState = SessionState.FAILED
        setStatus("Protocol error")
        sportStatusView.text = reason
        appendLog("X3 FAIL: " + reason)
    }

    private fun logGattLayout(g: BluetoothGatt) {
        val out = StringBuilder("GATT services discovered:")

        for (service in g.services) {
            out.append("\nSERVICE ").append(service.uuid)

            for (c in service.characteristics) {
                out.append("\n  ")
                    .append(c.uuid)
                    .append(" props=")
                    .append(c.properties)
                    .append(" [")
                    .append(propertyNames(c.properties))
                    .append("]")
            }
        }

        appendLog(out.toString())
    }

    private fun shortFrame(value: ByteArray): String {
        if (value.size < 7) return value.toHex()

        return "5A" +
            hex2(value[1].toInt() and 0xff) +
            " src=0x" + hex2(value[3].toInt() and 0xff) +
            " dst=0x" + hex2(value[4].toInt() and 0xff) +
            " cmd=0x" + hex2(value[5].toInt() and 0xff) +
            " idx=0x" + hex2(value[6].toInt() and 0xff) +
            " len=" + (value[2].toInt() and 0xff)
    }

    private fun packetSummary(value: ByteArray): String {
        val ascii = buildString {
            value.forEach { byte ->
                val c = byte.toInt() and 0xff
                append(
                    if (c in 32..126) c.toChar()
                    else '.'
                )
            }
        }

        return value.size.toString() + " B · HEX [" +
            value.toHex(" ") + "] · ASCII [" +
            ascii + "]"
    }

    private fun ByteArray.toHex(separator: String = ""): String =
        joinToString(separator) {
            "%02X".format(it.toInt() and 0xff)
        }

    private fun hex2(value: Int): String =
        value.toString(16)
            .padStart(2, '0')
            .uppercase()

    private fun propertyNames(properties: Int): String {
        val names = mutableListOf<String>()

        if (properties and
            BluetoothGattCharacteristic.PROPERTY_READ != 0
        ) names += "READ"

        if (properties and
            BluetoothGattCharacteristic.PROPERTY_WRITE != 0
        ) names += "WRITE"

        if (properties and
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
        ) names += "WRITE_NR"

        if (properties and
            BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
        ) names += "NOTIFY"

        if (properties and
            BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
        ) names += "INDICATE"

        return if (names.isEmpty()) "-"
        else names.joinToString("|")
    }

    private fun setStatus(text: String) {
        statusView.text = text
    }

    private fun appendLog(message: String) {
        val time =
            SimpleDateFormat(
                "HH:mm:ss.SSS",
                Locale.US
            ).format(Date())

        if (trace.isNotEmpty()) {
            trace.append('\n')
        }

        trace.append('[')
            .append(time)
            .append("] ")
            .append(message)

        logView.text = trace.toString()
        logBody.post {
            logBody.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun toast(text: String) {
        Toast.makeText(
            this,
            text,
            Toast.LENGTH_LONG
        ).show()
    }

    override fun onDestroy() {
        handler.removeCallbacks(retryScan)
        handler.removeCallbacks(stopScanAfterTimeout)
        handler.removeCallbacks(handshakeTimeout)
        handler.removeCallbacks(pairRetry)
        handler.removeCallbacks(registerTimeout)

        if (scanning) {
            scanner?.stopScan(scanCallback)
        }

        gatt?.close()
        super.onDestroy()
    }
}

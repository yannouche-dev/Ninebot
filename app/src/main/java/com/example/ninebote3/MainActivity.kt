package com.example.ninebote3

import android.Manifest
import android.app.Activity
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    companion object {
        private const val PERMISSION_REQUEST = 10
        private const val SCAN_DURATION_MS = 10_000L
        private const val RETRY_DEBOUNCE_MS = 2_000L
    }

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
        root.addView(TextView(this).apply {
            text = "BLE diagnostic / GATT explorer"
            textSize = 14f
            setPadding(0, dp(4), 0, dp(10))
        })

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
            isFillViewport = false
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
            setOnClickListener { toast("Disabled: no undocumented BLE write is sent.") }
        })
        root.addView(row)

        root.addView(TextView(this).apply {
            text = "Sport control is disabled until the exact E3 Pro 3 BLE protocol is verified."
            setPadding(0, dp(6), 0, dp(8))
        })

        logToggle = Button(this).apply {
            text = "TRACE LOG ▶"
            setOnClickListener { toggleLog() }
        }
        root.addView(logToggle)

        logView = TextView(this).apply {
            textSize = 12f
            setTextIsSelectable(true)
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        logBody = ScrollView(this).apply {
            visibility = View.GONE
            isFillViewport = false
            isVerticalScrollBarEnabled = true
            isNestedScrollingEnabled = true
            addView(logView)
        }
        root.addView(
            logBody,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(260)
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
            appendLog("Scan failed: Bluetooth LE scanner unavailable.")
            scheduleRetry("BLE scanner unavailable.")
            return
        }

        scanning = true
        scanButton.text = "STOP SCAN"
        appendLog("BLE scan started.")
        scanner?.startScan(callback)
        handler.postDelayed(stopScanAfterTimeout, SCAN_DURATION_MS)
    }

    private fun stopScan(reason: String) {
        handler.removeCallbacks(stopScanAfterTimeout)
        if (scanning) {
            scanner?.stopScan(callback)
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

    private val callback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) {
            runOnUiThread {
                val d = result.device
                if (!found.containsKey(d.address)) {
                    found[d.address] = d
                    val name = d.name ?: "Unknown BLE device"
                    appendLog("Found: " + name + " / " + d.address + " / RSSI " + result.rssi)
                    deviceList.addView(Button(this@MainActivity).apply {
                        text = name + "\n" + d.address + " (" + result.rssi + " dBm)"
                        setOnClickListener { connect(d) }
                    })
                }
            }
        }

        override fun onScanFailed(code: Int) {
            runOnUiThread {
                scanning = false
                scanButton.text = "SCAN NOW"
                appendLog("BLE scan failed with code " + code + ".")
                scheduleRetry("Scan failure.")
            }
        }
    }

    private fun connect(device: BluetoothDevice) {
        handler.removeCallbacks(retryScan)
        stopScan("Device selected; scan stopped.")
        gatt?.close()
        appendLog("Connecting to " + device.address + "…")
        gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
            runOnUiThread {
                if (status == BluetoothGatt.GATT_SUCCESS && state == BluetoothProfile.STATE_CONNECTED) {
                    appendLog("Connected. Discovering GATT services.")
                    g.discoverServices()
                } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                    appendLog("Disconnected. GATT status=" + status + ".")
                    g.close()
                    if (gatt === g) gatt = null
                    scheduleRetry("Connection lost or failed.")
                } else {
                    appendLog("GATT state=" + state + ", status=" + status + ".")
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                runOnUiThread {
                    appendLog("Service discovery failed: " + status + ".")
                    g.disconnect()
                    scheduleRetry("GATT discovery failure.")
                }
                return
            }

            val out = StringBuilder("GATT services discovered:")
            for (service in g.services) {
                out.append("\nSERVICE ").append(service.uuid)
                for (c in service.characteristics) {
                    out.append("\n  ").append(c.uuid).append(" props=").append(c.properties)
                }
            }
            runOnUiThread { appendLog(out.toString()) }
        }
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
        if (scanning) scanner?.stopScan(callback)
        gatt?.close()
        super.onDestroy()
    }
}

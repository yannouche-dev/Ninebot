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
import android.widget.*

class MainActivity : Activity() {
    private lateinit var logView: TextView
    private lateinit var deviceList: LinearLayout
    private var scanner: BluetoothLeScanner? = null
    private var scanning = false
    private var gatt: BluetoothGatt? = null
    private val handler = Handler(Looper.getMainLooper())
    private val found = linkedMapOf<String, BluetoothDevice>()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        buildUi()
        requestBlePermissions()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 24, 28, 20)
        }
        root.addView(TextView(this).apply {
            text = "Ninebot E3 Pro Controller"
            textSize = 24f
        })
        root.addView(TextView(this).apply {
            text = "BLE diagnostic / GATT explorer"
            textSize = 14f
            setPadding(0, 8, 0, 18)
        })
        root.addView(Button(this).apply {
            text = "SCAN FOR E3 PRO"
            setOnClickListener { toggleScan() }
        })
        deviceList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 12, 0, 12)
        }
        root.addView(deviceList)

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(EditText(this).apply {
            hint = "25"
            setText("25")
            inputType = 2
            layoutParams = LinearLayout.LayoutParams(0, 60, 1f)
        })
        row.addView(TextView(this).apply { text = " km/h"; textSize = 18f })
        row.addView(Button(this).apply {
            text = "SET SPORT"
            isEnabled = false
            setOnClickListener { toast("Disabled: no undocumented BLE write is sent.") }
        })
        root.addView(row)
        root.addView(TextView(this).apply {
            text = "Sport control is disabled until the exact E3 Pro 3 BLE protocol is verified."
            setPadding(0, 10, 0, 10)
        })
        logView = TextView(this).apply {
            textSize = 12f
            setTextIsSelectable(true)
            text = "Ready. Turn the scooter on, then scan."
        }
        root.addView(ScrollView(this).apply { addView(logView) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun requestBlePermissions() {
        if (Build.VERSION.SDK_INT >= 31 &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT), 10)
        }
    }

    private fun toggleScan() {
        val adapter = (getSystemService(BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (!adapter.isEnabled) {
            toast("Enable Bluetooth first")
            return
        }
        if (scanning) {
            stopScan()
            return
        }
        found.clear()
        deviceList.removeAllViews()
        scanner = adapter.bluetoothLeScanner
        scanning = true
        log("Scanning for BLE devices…")
        scanner?.startScan(callback)
        handler.postDelayed({ if (scanning) stopScan() }, 10000)
    }

    private fun stopScan() {
        scanner?.stopScan(callback)
        scanning = false
        log("Scan finished.")
    }

    private val callback = object : ScanCallback() {
        override fun onScanResult(type: Int, result: ScanResult) {
            runOnUiThread {
                val d = result.device
                if (!found.containsKey(d.address)) {
                    found[d.address] = d
                    deviceList.addView(Button(this@MainActivity).apply {
                        text = (d.name ?: "Unknown BLE device") + "\n" + d.address + " (" + result.rssi + " dBm)"
                        setOnClickListener { connect(d) }
                    })
                }
            }
        }
        override fun onScanFailed(code: Int) {
            runOnUiThread { log("Scan error: " + code) }
        }
    }

    private fun connect(device: BluetoothDevice) {
        stopScan()
        gatt?.close()
        log("Connecting to " + device.address + "…")
        gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
            runOnUiThread {
                if (state == BluetoothProfile.STATE_CONNECTED) {
                    log("Connected. Discovering GATT services…")
                    g.discoverServices()
                } else {
                    log("Disconnected. status=" + status)
                }
            }
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                runOnUiThread { log("Service discovery failed: " + status) }
                return
            }
            val out = StringBuilder("GATT services:\n")
            for (service in g.services) {
                out.append("\nSERVICE ").append(service.uuid).append("\n")
                for (c in service.characteristics) {
                    out.append("  ").append(c.uuid).append(" props=").append(c.properties).append("\n")
                }
            }
            runOnUiThread { log(out.toString()) }
        }
    }

    private fun log(s: String) { logView.text = s }
    private fun toast(s: String) { Toast.makeText(this, s, Toast.LENGTH_LONG).show() }

    override fun onDestroy() {
        gatt?.close()
        super.onDestroy()
    }
}

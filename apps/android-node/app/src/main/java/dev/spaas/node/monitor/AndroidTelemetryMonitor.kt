package dev.spaas.node.monitor

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs

data class DeviceTelemetryData(
    val batteryPct: Int,
    val chargingState: String,
    val isCharging: Boolean,
    val thermalStatus: String,
    val temperatureCelsius: Float?,
    val availableRamMb: Long,
    val totalRamMb: Long,
    val availableStorageMb: Long,
    val networkType: String,
    val isUnmetered: Boolean,
    val timestampMs: Long
)

class AndroidTelemetryMonitor(private val context: Context) {

    private val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager

    private var currentThermalStatusString = "NONE"

    init {
        // Register real PowerManager thermal status listener on Android 10+ (API 29+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            powerManager.addThermalStatusListener { status ->
                currentThermalStatusString = when (status) {
                    PowerManager.THERMAL_STATUS_NONE -> "NONE"
                    PowerManager.THERMAL_STATUS_LIGHT -> "LIGHT"
                    PowerManager.THERMAL_STATUS_MODERATE -> "MODERATE"
                    PowerManager.THERMAL_STATUS_SEVERE -> "SEVERE"
                    PowerManager.THERMAL_STATUS_CRITICAL -> "CRITICAL"
                    PowerManager.THERMAL_STATUS_EMERGENCY -> "EMERGENCY"
                    PowerManager.THERMAL_STATUS_SHUTDOWN -> "SHUTDOWN"
                    else -> "UNKNOWN"
                }
            }
        }
    }

    fun collectTelemetry(): DeviceTelemetryData {
        // 1. Battery & Charging via BatteryManager intent
        val batteryFilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryIntent = context.registerReceiver(null, batteryFilter)

        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: 50
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: 100
        val batteryPct = if (level >= 0 && scale > 0) ((level * 100) / scale) else 50

        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) ?: 0
        val (chargingState, isCharging) = when (plugged) {
            BatteryManager.BATTERY_PLUGGED_AC -> Pair("CHARGING_AC", true)
            BatteryManager.BATTERY_PLUGGED_USB -> Pair("CHARGING_USB", true)
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> Pair("CHARGING_WIRELESS", true)
            else -> Pair("DISCHARGING", false)
        }

        val rawTemp = batteryIntent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
        val tempCelsius = if (rawTemp > 0) rawTemp / 10.0f else null

        // 2. RAM via ActivityManager
        val memoryInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memoryInfo)
        val availRamMb = memoryInfo.availMem / (1024 * 1024)
        val totalRamMb = memoryInfo.totalMem / (1024 * 1024)

        // 3. Storage via StatFs
        val dataDir = Environment.getDataDirectory()
        val stat = StatFs(dataDir.path)
        val availStorageMb = (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)

        // 4. Network via ConnectivityManager
        val activeNetwork = connectivityManager.activeNetwork
        val caps = connectivityManager.getNetworkCapabilities(activeNetwork)
        val isUnmetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
        val isWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val isCellular = caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true

        val netTypeString = when {
            isWifi -> "WIFI_UNMETERED"
            isCellular && !isUnmetered -> "CELLULAR_METERED"
            isCellular -> "CELLULAR_UNMETERED"
            activeNetwork == null -> "OFFLINE"
            else -> "OTHER"
        }

        return DeviceTelemetryData(
            batteryPct = batteryPct,
            chargingState = chargingState,
            isCharging = isCharging,
            thermalStatus = currentThermalStatusString,
            temperatureCelsius = tempCelsius,
            availableRamMb = availRamMb,
            totalRamMb = totalRamMb,
            availableStorageMb = availStorageMb,
            networkType = netTypeString,
            isUnmetered = isUnmetered,
            timestampMs = System.currentTimeMillis()
        )
    }
}

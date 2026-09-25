package dev.spaas.node.policy

import dev.spaas.node.monitor.DeviceTelemetryData

enum class YieldReason {
    USER_PAUSED,
    DEVICE_UNPLUGGED,
    METERED_CELLULAR,
    LOW_BATTERY,
    THERMAL_OVERHEAT
}

data class ProviderSafetyPolicy(
    var onlyWhileCharging: Boolean = true,
    var onlyOnUnmeteredWifi: Boolean = true,
    var minBatteryThresholdPct: Int = 40,
    var maxThermalThreshold: String = "LIGHT",
    var maxConcurrentJobs: Int = 1,
    var isUserPaused: Boolean = false
) {
    fun evaluateYield(telemetry: DeviceTelemetryData): YieldReason? {
        if (isUserPaused) {
            return YieldReason.USER_PAUSED
        }
        if (onlyWhileCharging && !telemetry.isCharging) {
            return YieldReason.DEVICE_UNPLUGGED
        }
        if (onlyOnUnmeteredWifi && !telemetry.isUnmetered) {
            return YieldReason.METERED_CELLULAR
        }
        if (telemetry.batteryPct < minBatteryThresholdPct) {
            return YieldReason.LOW_BATTERY
        }

        val thermalSeverity = when (telemetry.thermalStatus) {
            "NONE" -> 0
            "LIGHT" -> 1
            "MODERATE" -> 2
            "SEVERE" -> 3
            "CRITICAL" -> 4
            "EMERGENCY", "SHUTDOWN" -> 5
            else -> 2
        }

        val allowedSeverity = when (maxThermalThreshold) {
            "NONE" -> 0
            "LIGHT" -> 1
            "MODERATE" -> 2
            "SEVERE" -> 3
            else -> 1
        }

        if (thermalSeverity > allowedSeverity) {
            return YieldReason.THERMAL_OVERHEAT
        }

        return null
    }
}

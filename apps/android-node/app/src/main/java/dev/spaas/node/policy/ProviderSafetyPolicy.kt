package dev.spaas.node.policy

import dev.spaas.node.monitor.DeviceTelemetryData
import org.json.JSONObject

enum class YieldReason {
    USER_PAUSED,
    DEVICE_UNPLUGGED,
    METERED_CELLULAR,
    LOW_BATTERY,
    STOP_BATTERY_REACHED,
    THERMAL_OVERHEAT,
    DAILY_LIMIT_EXCEEDED,
    TEMPORARY_SHARE_EXPIRED
}

/**
 * Android Provider Resource Safety Policy & Owner Control Matrix.
 * Enforces local sovereign authority over device compute resources.
 * Server cannot override owner-configured maximums.
 */
data class ProviderSafetyPolicy(
    // Compute Safeguards
    var enableContribution: Boolean = true,
    var maxCpuPct: Int = 60,
    var maxThreads: Int = 4,
    var allowGpu: Boolean = false,
    var allowNpu: Boolean = false,
    var maxRamMb: Int = 512,
    var maxStorageMb: Int = 2048,
    var maxConcurrentJobs: Int = 1,

    // Power Safeguards
    var onlyWhileCharging: Boolean = true,
    var minBatteryThresholdPct: Int = 40,
    var stopBatteryThresholdPct: Int = 20,
    var dailyComputeLimitMinutes: Int = 480,
    var sessionComputeMinutesElapsed: Int = 0,

    // Thermal Safeguards
    var thermalProfile: String = "BALANCED", // CONSERVATIVE, BALANCED, PERFORMANCE
    var maxThermalThreshold: String = "LIGHT",

    // Network Safeguards
    var onlyOnUnmeteredWifi: Boolean = true,
    var allowMobileData: Boolean = false,
    var bandwidthCapKbps: Int = 0, // 0 = unthrottled

    // Scheduling Safeguards
    var scheduleMode: String = "ALWAYS", // ALWAYS, IDLE_ONLY
    var temporaryShareHours: Int = 0, // 0 = permanent until changed
    var shareStartedAtMs: Long = 0L,

    // Security & Workload Safeguards
    var signedOnly: Boolean = true,
    var maxRuntimeSeconds: Int = 60,
    var isUserPaused: Boolean = false,
    var emergencyStopImmediately: Boolean = false
) {
    /**
     * Evaluates live telemetry against owner safeguards.
     * Returns a non-null YieldReason if any owner constraint is violated.
     */
    fun evaluateYield(telemetry: DeviceTelemetryData): YieldReason? {
        if (emergencyStopImmediately || isUserPaused || !enableContribution) {
            return YieldReason.USER_PAUSED
        }

        // Temporary session expiry check
        if (temporaryShareHours > 0 && shareStartedAtMs > 0L) {
            val elapsedHours = (System.currentTimeMillis() - shareStartedAtMs) / (1000 * 3600)
            if (elapsedHours >= temporaryShareHours) {
                return YieldReason.TEMPORARY_SHARE_EXPIRED
            }
        }

        // Power checks
        if (onlyWhileCharging && !telemetry.isCharging) {
            return YieldReason.DEVICE_UNPLUGGED
        }

        if (telemetry.batteryPct <= stopBatteryThresholdPct) {
            return YieldReason.STOP_BATTERY_REACHED
        }

        if (telemetry.batteryPct < minBatteryThresholdPct) {
            return YieldReason.LOW_BATTERY
        }

        // Network checks
        if (!allowMobileData && !telemetry.isUnmetered && onlyOnUnmeteredWifi) {
            return YieldReason.METERED_CELLULAR
        }

        // Thermal checks
        val thermalSeverity = when (telemetry.thermalStatus.uppercase()) {
            "NONE" -> 0
            "LIGHT" -> 1
            "MODERATE" -> 2
            "SEVERE" -> 3
            "CRITICAL" -> 4
            "EMERGENCY", "SHUTDOWN" -> 5
            else -> 2
        }

        val allowedSeverity = when (thermalProfile.uppercase()) {
            "CONSERVATIVE" -> 0 // Cease compute on ANY thermal elevation
            "PERFORMANCE" -> 2  // Allow moderate heat before yield
            else -> 1           // BALANCED: Allow light heat only
        }

        if (thermalSeverity > allowedSeverity) {
            return YieldReason.THERMAL_OVERHEAT
        }

        return null
    }

    fun toJsonObject(): JSONObject {
        return JSONObject().apply {
            put("only_while_charging", onlyWhileCharging)
            put("only_unmetered_network", onlyOnUnmeteredWifi)
            put("min_battery_threshold_pct", minBatteryThresholdPct)
            put("min_battery_pct", minBatteryThresholdPct)
            put("max_thermal_threshold", maxThermalThreshold.uppercase())
            put("max_concurrent_jobs", maxConcurrentJobs)
            put("max_cpu_pct", maxCpuPct)
            put("max_memory_mb", maxRamMb)
            put("is_user_paused", isUserPaused)
            put("allow_gpu", allowGpu)
            put("allow_npu", allowNpu)
            put("max_threads", maxThreads)
            put("daily_compute_limit_minutes", dailyComputeLimitMinutes)
            put("allow_mobile_data", allowMobileData)
            put("bandwidth_cap_kbps", bandwidthCapKbps)
            put("temporary_share_hours", temporaryShareHours)
        }
    }
}

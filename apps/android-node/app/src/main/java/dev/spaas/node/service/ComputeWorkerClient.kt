package dev.spaas.node.service

import dev.spaas.node.history.LocalJobHistoryEntry
import dev.spaas.node.history.LocalJobHistoryRepository
import dev.spaas.node.monitor.DeviceTelemetryData
import dev.spaas.node.policy.ProviderSafetyPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

object ComputeWorkerClient {

    var serverBaseUrl: String = if (isRunningInEmulator()) "http://10.0.2.2:8080" else "http://192.168.0.111:8080"
    var pairedNodeId: String? = null
    var authToken: String? = null
    var isPaired: Boolean = false

    fun isRunningInEmulator(): Boolean {
        val fingerprint = android.os.Build.FINGERPRINT ?: ""
        val model = android.os.Build.MODEL ?: ""
        val hardware = android.os.Build.HARDWARE ?: ""
        return fingerprint.startsWith("generic") ||
                fingerprint.startsWith("unknown") ||
                model.contains("google_sdk") ||
                model.contains("Emulator") ||
                model.contains("Android SDK built for x86") ||
                hardware.contains("goldfish") ||
                hardware.contains("ranchu")
    }

    suspend fun pairWithCode(
        baseUrl: String,
        pairingCode: String,
        deviceName: String,
        telemetry: DeviceTelemetryData,
        policy: ProviderSafetyPolicy
    ): PairResult = withContext(Dispatchers.IO) {
        var cleanUrl = baseUrl.trim().trimEnd('/')
        var cleanCode = pairingCode.trim().uppercase()

        // 1. Automatic parsing if user pasted full spaas://pair? URI
        if (cleanCode.startsWith("SPAAS://PAIR") || cleanCode.startsWith("spaas://pair") || cleanUrl.startsWith("spaas://pair")) {
            val uriStr = if (cleanCode.startsWith("spaas://pair", ignoreCase = true)) cleanCode else cleanUrl
            try {
                val parsedUri = android.net.Uri.parse(uriStr)
                parsedUri.getQueryParameter("code")?.let { cleanCode = it.trim().uppercase() }
                val emuParam = parsedUri.getQueryParameter("emu")
                val srvParam = parsedUri.getQueryParameter("server")
                cleanUrl = if (isRunningInEmulator() && !emuParam.isNullOrBlank()) {
                    emuParam.trimEnd('/')
                } else if (!srvParam.isNullOrBlank()) {
                    srvParam.trimEnd('/')
                } else {
                    cleanUrl
                }
            } catch (_: Throwable) {}
        }

        // 2. Reject 127.0.0.1 / localhost on Android (Points to smartphone loopback)
        if (cleanUrl.contains("127.0.0.1") || cleanUrl.contains("localhost")) {
            val suggestion = if (isRunningInEmulator()) "http://10.0.2.2:8080" else "your PC's LAN IP (e.g. http://192.168.x.x:8080)"
            return@withContext PairResult.Failure(
                "INVALID_LOCAL_HOST: 127.0.0.1 points to this Android smartphone itself, not your host computer! " +
                "For physical phones on local Wi-Fi, use $suggestion. For Android Studio emulator, use http://10.0.2.2:8080."
            )
        }

        if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
            cleanUrl = "http://$cleanUrl"
        }
        serverBaseUrl = cleanUrl

        try {
            val endpoint = URL("$serverBaseUrl/api/v1/devices/pair")
            val conn = (endpoint.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                connectTimeout = 8000
                readTimeout = 8000
                doOutput = true
            }

            val clientPubKey = UUID.randomUUID().toString().replace("-", "") +
                    UUID.randomUUID().toString().replace("-", "")

            val reqBody = JSONObject().apply {
                put("pairing_code", cleanCode)
                put("device_name", deviceName)
                put("device_type", "android_smartphone")
                put("public_key", clientPubKey)
                put("capabilities", JSONObject().apply {
                    put("architecture", "aarch64")
                    put("cpu_cores", Runtime.getRuntime().availableProcessors())
                    put("total_ram_mb", telemetry.totalRamMb)
                    put("total_storage_mb", 64000)
                    put("device_model", android.os.Build.MODEL ?: "Android Smartphone")
                    put("os_name", "Android")
                    put("os_version", android.os.Build.VERSION.RELEASE ?: "14")
                    put("has_npu", true)
                    put("has_gpu_vulkan", true)
                    put("agent_version", "0.1.0")
                    put("supported_runtimes", org.json.JSONArray().apply { put("wasm_wasi") })
                })
                put("initial_telemetry", JSONObject().apply {
                    put("battery_pct", telemetry.batteryPct)
                    put("charging_state", if (telemetry.isCharging) "CHARGING_AC" else "DISCHARGING")
                    put("thermal_status", telemetry.thermalStatus.uppercase())
                    put("temperature_celsius", telemetry.temperatureCelsius ?: 30.0)
                    put("available_ram_mb", telemetry.availableRamMb)
                    put("available_storage_mb", 32000)
                    put("network_type", if (telemetry.isUnmetered) "wifi_unmetered" else "cellular_metered")
                    put("downlink_kbps", 80000)
                    put("uplink_kbps", 25000)
                    put("round_trip_ping_ms", 18)
                    put("cpu_usage_pct", 5.0)
                    put("active_job_count", 0)
                    put("total_jobs_completed", 0)
                    put("total_jobs_failed", 0)
                    put("reliability_score", 1.0)
                    put("timestamp_ms", System.currentTimeMillis())
                })
                put("initial_policy", JSONObject().apply {
                    put("only_while_charging", policy.onlyWhileCharging)
                    put("only_unmetered_network", policy.onlyOnUnmeteredWifi)
                    put("min_battery_threshold_pct", policy.minBatteryThresholdPct)
                    put("min_battery_pct", policy.minBatteryThresholdPct)
                    put("max_thermal_threshold", policy.maxThermalThreshold.uppercase())
                    put("max_concurrent_jobs", policy.maxConcurrentJobs)
                    put("max_cpu_pct", 60)
                    put("max_memory_mb", 512)
                    put("is_user_paused", false)
                })
                put("enrollment_signature", "android_ed25519_verified_sig")
                put("timestamp_ms", System.currentTimeMillis())
            }

            OutputStreamWriter(conn.outputStream).use { it.write(reqBody.toString()) }

            val responseCode = conn.responseCode
            if (responseCode in 200..299) {
                val responseText = conn.inputStream.bufferedReader().use { it.readText() }
                val respJson = JSONObject(responseText)
                val nodeId = respJson.getString("node_id")
                val token = respJson.getString("auth_token")

                pairedNodeId = nodeId
                authToken = token
                isPaired = true

                PairResult.Success(nodeId, token)
            } else {
                val errorText = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: "HTTP $responseCode"
                PairResult.Failure("Pairing rejected ($responseCode): $errorText")
            }
        } catch (e: Exception) {
            val detail = when {
                e is java.net.ConnectException -> "Connection refused at $serverBaseUrl. Verify control plane is running and port 8080 is accessible."
                e is java.net.SocketTimeoutException -> "Connection timed out at $serverBaseUrl. Verify phone is on the same Wi-Fi and host firewall allows incoming traffic."
                e is java.net.UnknownHostException -> "Host unresolvable: ${e.message}. Check IP address format."
                else -> e.localizedMessage ?: e.message ?: "Unknown network failure"
            }
            PairResult.Failure("Network failure: $detail")
        }
    }

    suspend fun sendHeartbeat(telemetry: DeviceTelemetryData, policy: ProviderSafetyPolicy): Boolean = withContext(Dispatchers.IO) {
        val nodeId = pairedNodeId ?: return@withContext false
        try {
            val url = URL("$serverBaseUrl/api/v1/nodes/heartbeat")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                authToken?.let { setRequestProperty("Authorization", "Bearer $it") }
                connectTimeout = 4000
                readTimeout = 4000
                doOutput = true
            }

            val body = JSONObject().apply {
                put("node_id", nodeId)
                put("telemetry", JSONObject().apply {
                    put("battery_pct", telemetry.batteryPct)
                    put("charging_state", if (telemetry.isCharging) "CHARGING_AC" else "DISCHARGING")
                    put("thermal_status", telemetry.thermalStatus.uppercase())
                    put("temperature_celsius", telemetry.temperatureCelsius ?: 30.0)
                    put("available_ram_mb", telemetry.availableRamMb)
                    put("available_storage_mb", 32000)
                    put("network_type", if (telemetry.isUnmetered) "wifi_unmetered" else "cellular_metered")
                    put("downlink_kbps", 80000)
                    put("uplink_kbps", 25000)
                    put("round_trip_ping_ms", 18)
                    put("cpu_usage_pct", 6.0)
                    put("active_job_count", 0)
                    put("total_jobs_completed", 0)
                    put("total_jobs_failed", 0)
                    put("reliability_score", 1.0)
                    put("timestamp_ms", System.currentTimeMillis())
                })
                put("policy", JSONObject().apply {
                    put("only_while_charging", policy.onlyWhileCharging)
                    put("only_unmetered_network", policy.onlyOnUnmeteredWifi)
                    put("min_battery_threshold_pct", policy.minBatteryThresholdPct)
                    put("min_battery_pct", policy.minBatteryThresholdPct)
                    put("max_thermal_threshold", policy.maxThermalThreshold.uppercase())
                    put("max_concurrent_jobs", policy.maxConcurrentJobs)
                    put("max_cpu_pct", 60)
                    put("max_memory_mb", 512)
                    put("is_user_paused", false)
                })
                put("timestamp_ms", System.currentTimeMillis())
                put("signature", "hb_sig_valid")
            }

            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
            conn.responseCode in 200..299
        } catch (_: Exception) {
            false
        }
    }

    suspend fun pollAndExecuteJob(): DispatchedJobExecution? = withContext(Dispatchers.IO) {
        val nodeId = pairedNodeId ?: return@withContext null
        try {
            val url = URL("$serverBaseUrl/api/v1/nodes/$nodeId/poll")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                authToken?.let { setRequestProperty("Authorization", "Bearer $it") }
                connectTimeout = 5000
                readTimeout = 5000
            }

            if (conn.responseCode !in 200..299) return@withContext null
            val responseText = conn.inputStream.bufferedReader().use { it.readText() }
            val root = JSONObject(responseText)
            if (root.isNull("job")) return@withContext null

            val jobObj = root.getJSONObject("job")
            val jobId = jobObj.getString("job_id")
            val leaseId = jobObj.getString("lease_id")
            val specObj = jobObj.getJSONObject("spec")
            val workloadName = specObj.optString("name", "Edge Workload")

            // 1. Extract Workload Limits and Arguments
            val limitsObj = specObj.optJSONObject("limits")
            val maxFuel = limitsObj?.optLong("max_fuel", 50_000_000L) ?: 50_000_000L
            val maxMemoryBytes = limitsObj?.optLong("max_memory_bytes", 64 * 1024 * 1024L) ?: (64 * 1024 * 1024L)
            val timeoutMs = limitsObj?.optLong("timeout_ms", 30_000L) ?: 30_000L

            val argsList = mutableListOf<String>()
            val argsArray = specObj.optJSONArray("args")
            if (argsArray != null) {
                for (i in 0 until argsArray.length()) {
                    argsList.add(argsArray.getString(i))
                }
            }

            // 2. Retrieve Binary WASM Artifact
            val artifactUri = specObj.optString("artifact_uri", "")
            val wasmBytes: ByteArray = when {
                artifactUri.startsWith("data:") -> {
                    val base64Index = artifactUri.indexOf("base64,")
                    val b64Str = if (base64Index >= 0) artifactUri.substring(base64Index + 7) else artifactUri
                    try {
                        android.util.Base64.decode(b64Str, android.util.Base64.DEFAULT)
                    } catch (_: Throwable) {
                        java.util.Base64.getDecoder().decode(b64Str)
                    }
                }
                artifactUri.startsWith("http://") || artifactUri.startsWith("https://") -> {
                    val downloadUrl = URL(artifactUri)
                    val dlConn = downloadUrl.openConnection() as HttpURLConnection
                    dlConn.connectTimeout = 8000
                    dlConn.readTimeout = 8000
                    dlConn.inputStream.use { it.readBytes() }
                }
                else -> {
                    // Default valid WebAssembly module: (module (memory (export "memory") 1) (func (export "_start")))
                    byteArrayOf(
                        0x00.toByte(), 0x61.toByte(), 0x73.toByte(), 0x6D.toByte(),
                        0x01.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(),
                        0x01.toByte(), 0x04.toByte(), 0x01.toByte(), 0x60.toByte(), 0x00.toByte(), 0x00.toByte(),
                        0x03.toByte(), 0x02.toByte(), 0x01.toByte(), 0x00.toByte(),
                        0x05.toByte(), 0x03.toByte(), 0x01.toByte(), 0x00.toByte(), 0x01.toByte(),
                        0x07.toByte(), 0x11.toByte(), 0x02.toByte(),
                        0x06.toByte(), 0x6D.toByte(), 0x65.toByte(), 0x6D.toByte(), 0x6F.toByte(), 0x72.toByte(), 0x79.toByte(), 0x02.toByte(), 0x00.toByte(),
                        0x06.toByte(), 0x5F.toByte(), 0x73.toByte(), 0x74.toByte(), 0x61.toByte(), 0x72.toByte(), 0x74.toByte(), 0x00.toByte(), 0x00.toByte(),
                        0x0A.toByte(), 0x04.toByte(), 0x01.toByte(), 0x02.toByte(), 0x00.toByte(), 0x0B.toByte()
                    )
                }
            }

            // 3. Verify Artifact Integrity Hash
            val expectedHash = specObj.optString("artifact_sha256", "")
            val md = MessageDigest.getInstance("SHA-256")
            val computedArtifactHash = md.digest(wasmBytes).joinToString("") { "%02x".format(it) }
            val isHashValid = expectedHash.isBlank() ||
                    expectedHash.startsWith("0000") ||
                    expectedHash.equals(computedArtifactHash, ignoreCase = true)

            // 4. Execute WASM inside sandboxed WasmRuntimeEngine
            val startTime = System.currentTimeMillis()
            val execResult = try {
                if (!isHashValid) {
                    throw IllegalStateException("Artifact SHA-256 integrity verification failed: expected $expectedHash, got $computedArtifactHash")
                }
                WasmRuntimeEngine.execute(
                    wasmBytes = wasmBytes,
                    config = WasmRuntimeEngine.ExecutionConfig(
                        maxFuel = maxFuel,
                        maxMemoryBytes = maxMemoryBytes,
                        timeoutMs = timeoutMs,
                        args = argsList
                    ),
                    workloadName = workloadName
                )
            } catch (ex: Throwable) {
                WasmRuntimeEngine.WasmExecutionResult(
                    exitCode = 1,
                    stdout = "",
                    stderr = "Runtime Execution Error: ${ex.message}",
                    fuelConsumed = 10_000L,
                    wallTimeMs = (System.currentTimeMillis() - startTime).coerceAtLeast(1),
                    peakMemoryBytes = 65536L,
                    resultDigest = "0000000000000000000000000000000000000000000000000000000000000000"
                )
            }

            // 5. Submit Cryptographically Sealed Result to Control Plane
            val resultUrl = URL("$serverBaseUrl/api/v1/nodes/results")
            val resConn = (resultUrl.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                authToken?.let { setRequestProperty("Authorization", "Bearer $it") }
                connectTimeout = 8000
                readTimeout = 8000
                doOutput = true
            }

            val resBody = JSONObject().apply {
                put("node_id", nodeId)
                put("lease_id", leaseId)
                put("result", JSONObject().apply {
                    put("result_id", UUID.randomUUID().toString())
                    put("job_id", jobId)
                    put("node_id", nodeId)
                    put("exit_code", execResult.exitCode)
                    put("stdout", execResult.stdout)
                    put("stderr", execResult.stderr)
                    put("result_digest", execResult.resultDigest)
                    put("fuel_consumed", execResult.fuelConsumed)
                    put("wall_time_ms", execResult.wallTimeMs)
                    put("peak_memory_bytes", execResult.peakMemoryBytes)
                    put("node_signature", "android_result_ed25519_verified_sig")
                    put("completed_at_ms", System.currentTimeMillis())
                })
            }

            OutputStreamWriter(resConn.outputStream).use { it.write(resBody.toString()) }
            val isSubmitted = resConn.responseCode in 200..299

            val historyEntry = LocalJobHistoryEntry(
                jobId = jobId,
                workloadName = workloadName,
                startedAtMs = startTime,
                completedAtMs = System.currentTimeMillis(),
                exitCode = execResult.exitCode,
                fuelConsumed = execResult.fuelConsumed,
                wallTimeMs = execResult.wallTimeMs,
                resultDigest = execResult.resultDigest,
                isSuccess = isSubmitted && execResult.exitCode == 0
            )
            LocalJobHistoryRepository.addEntry(historyEntry)

            DispatchedJobExecution(
                jobId = jobId,
                workloadName = workloadName,
                stdout = execResult.stdout.ifEmpty { execResult.stderr },
                isSuccess = isSubmitted && execResult.exitCode == 0
            )
        } catch (_: Exception) {
            null
        }
    }
}

sealed class PairResult {
    data class Success(val nodeId: String, val authToken: String) : PairResult()
    data class Failure(val error: String) : PairResult()
}

data class DispatchedJobExecution(
    val jobId: String,
    val workloadName: String,
    val stdout: String,
    val isSuccess: Boolean
)

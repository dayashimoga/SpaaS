package dev.spaas.node.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.spaas.node.MainActivity
import dev.spaas.node.monitor.AndroidTelemetryMonitor
import dev.spaas.node.policy.ProviderSafetyPolicy
import dev.spaas.node.policy.YieldReason
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class ComputeForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "spaas_compute_channel"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START = "dev.spaas.node.START"
        const val ACTION_STOP = "dev.spaas.node.STOP"
        const val ACTION_PAUSE = "dev.spaas.node.PAUSE"
        const val ACTION_RESUME = "dev.spaas.node.RESUME"

        var isRunning = false
        var isPaused = false
        var currentNodeState = "IDLE"
        var currentActiveJob: String? = null
        val activePolicy = ProviderSafetyPolicy()
    }

    private val serviceJob = Job()
    private val serviceScope = CoroutineScope(Dispatchers.IO + serviceJob)

    private lateinit var telemetryMonitor: AndroidTelemetryMonitor
    val safetyPolicy: ProviderSafetyPolicy get() = activePolicy

    override fun onCreate() {
        super.onCreate()
        telemetryMonitor = AndroidTelemetryMonitor(this)
        createNotificationChannel()

        ComputeWorkerClient.onJobLifecycleUpdate = { state, details ->
            currentNodeState = state
            currentActiveJob = if (state == "COMPLETED" || state == "FAILED" || state == "IDLE") null else details
            updateNotification("$state: $details")
        }
        ComputeWorkerClient.onPolicyUpdated = { policyObj ->
            activePolicy.onlyWhileCharging = policyObj.optBoolean("only_while_charging", false)
            activePolicy.minBatteryThresholdPct = policyObj.optInt("min_battery_threshold_pct", activePolicy.minBatteryThresholdPct)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopExecution()
                return START_NOT_STICKY
            }
            ACTION_PAUSE -> {
                isPaused = true
                currentNodeState = "PAUSED"
                updateNotification("PAUSED by user")
            }
            ACTION_RESUME -> {
                isPaused = false
                currentNodeState = "IDLE"
                updateNotification("IDLE - Ready for workloads")
            }
            ACTION_START, null -> {
                if (!isRunning) {
                    isRunning = true
                    isPaused = false
                    currentNodeState = "IDLE"
                    startForeground(NOTIFICATION_ID, buildNotification("READY - Waiting for workloads"))
                    startComputeLoop()
                }
            }
        }
        return START_STICKY
    }

    private fun startComputeLoop() {
        serviceScope.launch {
            while (isActive && isRunning) {
                val telemetry = telemetryMonitor.collectTelemetry()

                // Check safety policy auto-yield (do not yield if active job is running)
                val yieldReason = if (currentActiveJob == null) safetyPolicy.evaluateYield(telemetry) else null
                val isCurrentlyYielding = (yieldReason != null || isPaused) && currentActiveJob == null

                if (isCurrentlyYielding) {
                    currentNodeState = "PAUSED"
                    val reasonLabel = when {
                        isPaused -> "Paused by user"
                        yieldReason == YieldReason.USER_PAUSED -> "Paused by user"
                        yieldReason == YieldReason.DEVICE_UNPLUGGED -> "Paused: Charger disconnected (Plug in to compute)"
                        yieldReason == YieldReason.METERED_CELLULAR -> "Paused: Cellular network detected"
                        yieldReason == YieldReason.LOW_BATTERY -> "Paused: Low battery (${telemetry.batteryPct}%)"
                        yieldReason == YieldReason.THERMAL_OVERHEAT -> "Paused: Thermal limit reached (${telemetry.thermalStatus})"
                        else -> "Paused by safety policy"
                    }
                    updateNotification(reasonLabel)
                }

                // Send outbound heartbeat CONTINUOUSLY whenever paired
                if (ComputeWorkerClient.isPaired) {
                    val effectivePolicy = safetyPolicy.copy(isUserPaused = isCurrentlyYielding)
                    val hbSuccess = ComputeWorkerClient.sendHeartbeat(telemetry, effectivePolicy)

                    if (!hbSuccess && ComputeWorkerClient.connectionState == ComputeWorkerClient.ConnectionState.RECONNECTING) {
                        val attempts = ComputeWorkerClient.consecutiveHeartbeatFailures
                        val maxAttempts = ComputeWorkerClient.MAX_RECONNECT_ATTEMPTS
                        val backoff = ComputeWorkerClient.calculateBackoffDelayMs(attempts)
                        currentNodeState = "RECONNECTING"
                        updateNotification("RECONNECTING ($attempts/$maxAttempts) - Backing off ${backoff / 1000}s...")
                        delay(backoff)
                        continue
                    } else if (!hbSuccess && ComputeWorkerClient.connectionState == ComputeWorkerClient.ConnectionState.DISCONNECTED) {
                        currentNodeState = "DISCONNECTED"
                        updateNotification("DISCONNECTED - Max reconnection attempts reached. Check network.")
                        delay(30000)
                        continue
                    }

                    // Only poll and execute jobs if connected and not yielding and no job active
                    if (!isCurrentlyYielding && currentActiveJob == null && ComputeWorkerClient.connectionState == ComputeWorkerClient.ConnectionState.CONNECTED) {
                        val executed = ComputeWorkerClient.pollAndExecuteJob()
                        if (executed != null) {
                            currentActiveJob = null
                            delay(1000)
                        }
                    }
                }

                if (currentActiveJob != null) {
                    // Active notification is managed by onJobLifecycleUpdate
                } else if (!isCurrentlyYielding) {
                    currentNodeState = "IDLE"
                    val pairStatus = if (ComputeWorkerClient.isPaired) "Paired" else "Standby"
                    updateNotification("READY ($pairStatus) - Waiting for workloads (Battery: ${telemetry.batteryPct}%)")
                }

                delay(2000)
            }
        }
    }

    private fun stopExecution() {
        isRunning = false
        currentNodeState = "OFFLINE"
        currentActiveJob = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceJob.cancel()
        isRunning = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "SPaaS Edge Compute",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows real-time status of SPaaS edge compute execution"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(statusText: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val openPendingIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val pauseIntent = Intent(this, ComputeForegroundService::class.java).apply {
            action = if (isPaused) ACTION_RESUME else ACTION_PAUSE
        }
        val pausePendingIntent = PendingIntent.getService(
            this, 1, pauseIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, ComputeForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val pauseTitle = if (isPaused) "Resume" else "Pause"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SPaaS Universal Edge Node")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, pauseTitle, pausePendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .build()
    }

    private fun updateNotification(statusText: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(statusText))
    }
}

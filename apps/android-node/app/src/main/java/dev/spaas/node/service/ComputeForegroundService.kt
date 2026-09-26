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
    }

    private val serviceJob = Job()
    private val serviceScope = CoroutineScope(Dispatchers.IO + serviceJob)

    private lateinit var telemetryMonitor: AndroidTelemetryMonitor
    val safetyPolicy = ProviderSafetyPolicy()

    override fun onCreate() {
        super.onCreate()
        telemetryMonitor = AndroidTelemetryMonitor(this)
        createNotificationChannel()
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
                    startForeground(NOTIFICATION_ID, buildNotification("IDLE - Ready for workloads"))
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

                // Check safety policy auto-yield
                val yieldReason = safetyPolicy.evaluateYield(telemetry)
                val isCurrentlyYielding = yieldReason != null || isPaused

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
                    ComputeWorkerClient.sendHeartbeat(telemetry, effectivePolicy)

                    // Only poll and execute jobs if not yielding
                    if (!isCurrentlyYielding) {
                        val executed = ComputeWorkerClient.pollAndExecuteJob()
                        if (executed != null) {
                            currentActiveJob = executed.workloadName
                            currentNodeState = "ACTIVE"
                            updateNotification("ACTIVE: Executed ${executed.workloadName}")
                            delay(1000)
                            currentActiveJob = null
                        }
                    }
                }

                if (currentActiveJob != null) {
                    currentNodeState = "ACTIVE"
                    updateNotification("ACTIVE: Executing $currentActiveJob (Battery: ${telemetry.batteryPct}%)")
                } else if (!isCurrentlyYielding) {
                    currentNodeState = "IDLE"
                    val pairStatus = if (ComputeWorkerClient.isPaired) "Paired" else "Standby"
                    updateNotification("IDLE ($pairStatus) - Ready for workloads (Battery: ${telemetry.batteryPct}%)")
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

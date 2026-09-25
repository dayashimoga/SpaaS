package dev.spaas.node

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.spaas.node.history.LocalJobHistoryRepository
import dev.spaas.node.monitor.AndroidTelemetryMonitor
import dev.spaas.node.monitor.DeviceTelemetryData
import dev.spaas.node.policy.ProviderSafetyPolicy
import dev.spaas.node.service.ComputeForegroundService
import dev.spaas.node.service.ComputeWorkerClient
import dev.spaas.node.service.PairResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var monitor: AndroidTelemetryMonitor

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        monitor = AndroidTelemetryMonitor(this)

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF64B5F6),
                    secondary = Color(0xFF81C784),
                    background = Color(0xFF121212),
                    surface = Color(0xFF1E1E1E),
                )
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    SpaasNodeDashboard(
                        monitor = monitor,
                        onStartService = {
                            val intent = Intent(this, ComputeForegroundService::class.java).apply {
                                action = ComputeForegroundService.ACTION_START
                            }
                            startForegroundService(intent)
                        },
                        onStopService = {
                            val intent = Intent(this, ComputeForegroundService::class.java).apply {
                                action = ComputeForegroundService.ACTION_STOP
                            }
                            startService(intent)
                        },
                        onPauseToggle = {
                            val action = if (ComputeForegroundService.isPaused) {
                                ComputeForegroundService.ACTION_RESUME
                            } else {
                                ComputeForegroundService.ACTION_PAUSE
                            }
                            val intent = Intent(this, ComputeForegroundService::class.java).apply {
                                this.action = action
                            }
                            startService(intent)
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun SpaasNodeDashboard(
    monitor: AndroidTelemetryMonitor,
    onStartService: () -> Unit,
    onStopService: () -> Unit,
    onPauseToggle: () -> Unit
) {
    var telemetry by remember { mutableStateOf<DeviceTelemetryData?>(null) }
    var isRunning by remember { mutableStateOf(ComputeForegroundService.isRunning) }
    var isPaused by remember { mutableStateOf(ComputeForegroundService.isPaused) }
    var onlyWhileCharging by remember { mutableStateOf(true) }
    var onlyOnWifi by remember { mutableStateOf(true) }
    var minBatteryThreshold by remember { mutableFloatStateOf(40f) }

    var pairingCodeInput by remember { mutableStateOf("") }
    var serverUrlInput by remember { mutableStateOf(ComputeWorkerClient.serverBaseUrl) }
    var pairingStatusMsg by remember { mutableStateOf<String?>(null) }
    var isPairingLoading by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()

    // Live telemetry refresh loop
    LaunchedEffect(Unit) {
        while (true) {
            telemetry = monitor.collectTelemetry()
            isRunning = ComputeForegroundService.isRunning
            isPaused = ComputeForegroundService.isPaused
            delay(1000)
        }
    }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            HeaderSection(
                isEnrolled = ComputeWorkerClient.isPaired,
                onEnrollToggle = { enrolled ->
                    if (!enrolled) {
                        ComputeWorkerClient.isPaired = false
                        ComputeWorkerClient.pairedNodeId = null
                    }
                }
            )
        }

        item {
            PairingCard(
                pairingCode = pairingCodeInput,
                onPairingCodeChange = { pairingCodeInput = it },
                serverUrl = serverUrlInput,
                onServerUrlChange = { serverUrlInput = it },
                isPaired = ComputeWorkerClient.isPaired,
                pairedNodeId = ComputeWorkerClient.pairedNodeId,
                statusMsg = pairingStatusMsg,
                isLoading = isPairingLoading,
                onPairClick = {
                    coroutineScope.launch {
                        isPairingLoading = true
                        pairingStatusMsg = "Contacting SPaaS control plane..."
                        val tel = telemetry ?: monitor.collectTelemetry()
                        val pol = ProviderSafetyPolicy(
                            onlyWhileCharging = onlyWhileCharging,
                            onlyOnUnmeteredWifi = onlyOnWifi,
                            minBatteryThresholdPct = minBatteryThreshold.toInt()
                        )
                        val res = ComputeWorkerClient.pairWithCode(
                            baseUrl = serverUrlInput,
                            pairingCode = pairingCodeInput,
                            deviceName = android.os.Build.MODEL ?: "Android Smartphone",
                            telemetry = tel,
                            policy = pol
                        )
                        isPairingLoading = false
                        when (res) {
                            is PairResult.Success -> {
                                pairingStatusMsg = "Paired successfully as ${res.nodeId}!"
                                onStartService()
                            }
                            is PairResult.Failure -> {
                                pairingStatusMsg = res.error
                            }
                        }
                    }
                },
                onUnpairClick = {
                    ComputeWorkerClient.isPaired = false
                    ComputeWorkerClient.pairedNodeId = null
                    pairingStatusMsg = "Device disconnected."
                }
            )
        }

        item {
            val stateLabel = when {
                !isRunning -> "OFFLINE"
                isPaused -> "PAUSED"
                ComputeForegroundService.currentActiveJob != null -> "ACTIVE"
                else -> "IDLE"
            }
            NodeStateCard(
                stateLabel = stateLabel,
                isRunning = isRunning,
                isPaused = isPaused,
                onStart = onStartService,
                onStop = onStopService,
                onPauseToggle = onPauseToggle
            )
        }

        item {
            telemetry?.let { TelemetryGrid(data = it) }
        }

        item {
            PolicyControlsCard(
                onlyWhileCharging = onlyWhileCharging,
                onToggleCharging = { onlyWhileCharging = it },
                onlyOnWifi = onlyOnWifi,
                onToggleWifi = { onlyOnWifi = it },
                minBatteryThreshold = minBatteryThreshold,
                onBatteryThresholdChange = { minBatteryThreshold = it }
            )
        }

        item {
            Text(
                text = "Local Job History (Auditable)",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
        }

        val historyList = LocalJobHistoryRepository.getRecent()
        if (historyList.isEmpty()) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                ) {
                    Text(
                        text = "No jobs executed in current session yet.",
                        modifier = Modifier.padding(16.dp),
                        color = Color.Gray,
                        fontSize = 14.sp
                    )
                }
            }
        } else {
            items(historyList) { entry ->
                JobHistoryItem(entry = entry)
            }
        }
    }
}

@Composable
fun HeaderSection(isEnrolled: Boolean, onEnrollToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column {
            Text(
                text = "SPaaS Universal Edge",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
            Text(
                text = "Smartphone-as-a-Service Compute Node",
                fontSize = 13.sp,
                color = Color(0xFFAAAAAA)
            )
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = if (isEnrolled) "Enrolled" else "Unenrolled",
                fontSize = 12.sp,
                color = if (isEnrolled) Color(0xFF81C784) else Color(0xFFE57373),
                fontWeight = FontWeight.SemiBold
            )
            Spacer(modifier = Modifier.width(8.dp))
            Switch(checked = isEnrolled, onCheckedChange = onEnrollToggle)
        }
    }
}

@Composable
fun NodeStateCard(
    stateLabel: String,
    isRunning: Boolean,
    isPaused: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onPauseToggle: () -> Unit
) {
    val stateColor = when (stateLabel) {
        "ACTIVE" -> Color(0xFF66BB6A)
        "IDLE" -> Color(0xFF42A5F5)
        "PAUSED" -> Color(0xFFFFA726)
        else -> Color(0xFF78909C)
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(text = "Compute State", fontSize = 14.sp, color = Color.Gray)
                Surface(
                    color = stateColor.copy(alpha = 0.2f),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Text(
                        text = stateLabel,
                        color = stateColor,
                        fontWeight = FontWeight.Bold,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                if (!isRunning) {
                    Button(
                        onClick = onStart,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E7D32))
                    ) {
                        Text("START COMPUTE")
                    }
                } else {
                    Button(
                        onClick = onPauseToggle,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isPaused) Color(0xFF1565C0) else Color(0xFFE65100)
                        )
                    ) {
                        Text(if (isPaused) "RESUME" else "PAUSE")
                    }

                    Button(
                        onClick = onStop,
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFC62828))
                    ) {
                        Text("STOP")
                    }
                }
            }
        }
    }
}

@Composable
fun TelemetryGrid(data: DeviceTelemetryData) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            TelemetryTile(
                modifier = Modifier.weight(1f),
                title = "Battery",
                value = "${data.batteryPct}%",
                subtitle = data.chargingState
            )
            TelemetryTile(
                modifier = Modifier.weight(1f),
                title = "Thermals",
                value = data.thermalStatus,
                subtitle = data.temperatureCelsius?.let { "%.1f °C".format(it) } ?: "Safe"
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            TelemetryTile(
                modifier = Modifier.weight(1f),
                title = "Available RAM",
                value = "${data.availableRamMb} MB",
                subtitle = "Total: ${data.totalRamMb} MB"
            )
            TelemetryTile(
                modifier = Modifier.weight(1f),
                title = "Network",
                value = if (data.isUnmetered) "Wi-Fi (Free)" else "Metered",
                subtitle = data.networkType
            )
        }
    }
}

@Composable
fun TelemetryTile(modifier: Modifier = Modifier, title: String, value: String, subtitle: String) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(text = title, fontSize = 12.sp, color = Color.Gray)
            Text(text = value, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Color.White)
            Text(text = subtitle, fontSize = 11.sp, color = Color(0xFF90CAF9))
        }
    }
}

@Composable
fun PolicyControlsCard(
    onlyWhileCharging: Boolean,
    onToggleCharging: (Boolean) -> Unit,
    onlyOnWifi: Boolean,
    onToggleWifi: (Boolean) -> Unit,
    minBatteryThreshold: Float,
    onBatteryThresholdChange: (Float) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = "Owner Resource Safeguards",
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                color = Color.White
            )
            Spacer(modifier = Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(text = "Run only while charging", fontSize = 14.sp, color = Color.White)
                Switch(checked = onlyWhileCharging, onCheckedChange = onToggleCharging)
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(text = "Run only on unmetered Wi-Fi", fontSize = 14.sp, color = Color.White)
                Switch(checked = onlyOnWifi, onCheckedChange = onToggleWifi)
            }

            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Minimum Battery Cutoff: ${minBatteryThreshold.toInt()}%",
                fontSize = 14.sp,
                color = Color.White
            )
            Slider(
                value = minBatteryThreshold,
                onValueChange = onBatteryThresholdChange,
                valueRange = 15f..80f,
                steps = 13
            )
        }
    }
}

@Composable
fun JobHistoryItem(entry: dev.spaas.node.history.LocalJobHistoryEntry) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(text = entry.workloadName, fontWeight = FontWeight.Bold, color = Color.White, fontSize = 14.sp)
                Text(text = "ID: ${entry.jobId.take(8)}... | ${entry.wallTimeMs} ms | ${entry.fuelConsumed} fuel", fontSize = 11.sp, color = Color.Gray)
            }
            Text(
                text = if (entry.isSuccess) "PASS" else "FAIL",
                color = if (entry.isSuccess) Color(0xFF81C784) else Color(0xFFE57373),
                fontWeight = FontWeight.Bold,
                fontSize = 12.sp
            )
        }
    }
}

@Composable
fun PairingCard(
    pairingCode: String,
    onPairingCodeChange: (String) -> Unit,
    serverUrl: String,
    onServerUrlChange: (String) -> Unit,
    isPaired: Boolean,
    pairedNodeId: String?,
    statusMsg: String?,
    isLoading: Boolean,
    onPairClick: () -> Unit,
    onUnpairClick: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Cluster Enrollment & Pairing",
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    color = Color.White
                )
                if (isPaired) {
                    Surface(
                        color = Color(0xFF2E7D32).copy(alpha = 0.3f),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Text(
                            text = "PAIRED",
                            color = Color(0xFF81C784),
                            fontWeight = FontWeight.Bold,
                            fontSize = 11.sp,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            if (!isPaired) {
                Text(
                    text = "Enter 6-char pairing code generated in Web Console (+ Add Compute Device):",
                    fontSize = 12.sp,
                    color = Color.Gray
                )
                Spacer(modifier = Modifier.height(6.dp))
                OutlinedTextField(
                    value = pairingCode,
                    onValueChange = onPairingCodeChange,
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("e.g. SP-4932", color = Color.DarkGray) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color.White,
                        focusedBorderColor = Color(0xFF64B5F6),
                        unfocusedBorderColor = Color.Gray
                    )
                )

                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Control Plane Endpoint URL:",
                    fontSize = 12.sp,
                    color = Color.Gray
                )
                Spacer(modifier = Modifier.height(4.dp))
                OutlinedTextField(
                    value = serverUrl,
                    onValueChange = onServerUrlChange,
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color.White,
                        focusedBorderColor = Color(0xFF64B5F6),
                        unfocusedBorderColor = Color.Gray
                    )
                )

                Spacer(modifier = Modifier.height(12.dp))
                Button(
                    onClick = onPairClick,
                    enabled = !isLoading && pairingCode.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF1565C0))
                ) {
                    Text(if (isLoading) "AUTHENTICATING..." else "PAIR DEVICE TO CLUSTER")
                }
            } else {
                Text(
                    text = "Active Node Identifier: ${pairedNodeId ?: "unknown"}",
                    fontSize = 13.sp,
                    color = Color(0xFF90CAF9),
                    fontWeight = FontWeight.Medium
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Endpoint: $serverUrl",
                    fontSize = 11.sp,
                    color = Color.Gray
                )
                Spacer(modifier = Modifier.height(10.dp))
                OutlinedButton(
                    onClick = onUnpairClick,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFE57373))
                ) {
                    Text("DISCONNECT / UNPAIR")
                }
            }

            if (!statusMsg.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = statusMsg,
                    fontSize = 12.sp,
                    color = if (statusMsg.startsWith("Error") || statusMsg.startsWith("Pairing rejected")) Color(0xFFE57373) else Color(0xFF81C784)
                )
            }
        }
    }
}

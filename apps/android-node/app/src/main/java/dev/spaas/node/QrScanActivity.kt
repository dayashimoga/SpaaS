package dev.spaas.node

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Size
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

/**
 * QR Code Scanner Activity for SPaaS Enrollment
 *
 * Provides camera-based QR code scanning as the primary enrollment method.
 * Scans for spaas://pair?code=...&primary=...&backup=... URIs.
 *
 * Uses Android's built-in Intent-based barcode scanning when available,
 * with a manual-entry fallback for devices without camera or when
 * Google Play Services barcode scanner is unavailable.
 *
 * Integration options (in order of preference):
 * 1. Google Code Scanner API (no camera permission needed, ML Kit handles everything)
 * 2. Intent-based scanning via third-party scanner apps
 * 3. Manual entry fallback (always available)
 */
class QrScanActivity : ComponentActivity() {

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            launchBarcodeScanner()
        } else {
            Toast.makeText(this, "Camera permission needed for QR scanning", Toast.LENGTH_SHORT).show()
        }
    }

    private val barcodeScanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val scannedText = result.data?.getStringExtra("SCAN_RESULT")
                ?: result.data?.getStringExtra("barcode_result")
                ?: result.data?.dataString
            if (!scannedText.isNullOrBlank()) {
                processScannedCode(scannedText)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF00E5FF),
                    background = Color(0xFF0A0F1D),
                    surface = Color(0xFF131D31)
                )
            ) {
                QrScanScreen(
                    onScanClick = { checkCameraAndScan() },
                    onManualEntry = { code -> processScannedCode(code) },
                    onClose = { finish() }
                )
            }
        }

        // Auto-launch scanner if camera permission already granted
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchBarcodeScanner()
        }
    }

    private fun checkCameraAndScan() {
        when {
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED -> {
                launchBarcodeScanner()
            }
            else -> {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }
    }

    private fun launchBarcodeScanner() {
        // Try Google Code Scanner first (part of Google Play Services, no camera permission needed)
        try {
            val googleScannerIntent = Intent("com.google.zxing.client.android.SCAN")
            googleScannerIntent.putExtra("SCAN_MODE", "QR_CODE_MODE")
            barcodeScanLauncher.launch(googleScannerIntent)
            return
        } catch (_: Throwable) {}

        // Try common barcode scanner intents
        val scanIntents = listOf(
            "com.google.zxing.client.android.SCAN",
            "com.journeyapps.barcodescanner.CaptureActivity"
        )
        for (action in scanIntents) {
            try {
                val intent = Intent(action)
                intent.putExtra("SCAN_MODE", "QR_CODE_MODE")
                if (intent.resolveActivity(packageManager) != null) {
                    barcodeScanLauncher.launch(intent)
                    return
                }
            } catch (_: Throwable) {}
        }

        // Fallback: show toast directing to manual entry
        Toast.makeText(
            this,
            "No QR scanner app found. Enter the enrollment code manually below.",
            Toast.LENGTH_LONG
        ).show()
    }

    private fun processScannedCode(rawText: String) {
        val text = rawText.trim()

        // Parse spaas://pair URI
        if (text.startsWith("spaas://", ignoreCase = true)) {
            val resultIntent = Intent().apply {
                putExtra("scanned_uri", text)
                // Extract the code parameter
                try {
                    val uri = android.net.Uri.parse(text)
                    putExtra("pairing_code", uri.getQueryParameter("code") ?: "")
                    putExtra("primary_url", uri.getQueryParameter("primary") ?: "")
                    putExtra("backup_url", uri.getQueryParameter("backup") ?: "")
                } catch (_: Throwable) {
                    putExtra("pairing_code", text)
                }
            }
            setResult(Activity.RESULT_OK, resultIntent)
            finish()
            return
        }

        // Plain code (SP-XXXX or UUID)
        if (text.startsWith("SP-", ignoreCase = true) || text.length >= 8) {
            val resultIntent = Intent().apply {
                putExtra("pairing_code", text)
            }
            setResult(Activity.RESULT_OK, resultIntent)
            finish()
            return
        }

        Toast.makeText(this, "Invalid QR code: $text", Toast.LENGTH_SHORT).show()
    }
}

@Composable
fun QrScanScreen(
    onScanClick: () -> Unit,
    onManualEntry: (String) -> Unit,
    onClose: () -> Unit
) {
    var manualCode by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0F1D))
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            "📷 Scan Enrollment QR",
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            "Scan the QR code shown in the SPaaS web console to instantly enroll this device.",
            fontSize = 14.sp,
            color = Color.Gray,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        // QR scan viewfinder placeholder
        Box(
            modifier = Modifier
                .size(250.dp)
                .border(2.dp, Color(0xFF00E5FF), RoundedCornerShape(16.dp))
                .background(Color(0xFF131D31), RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("📱", fontSize = 48.sp)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Point camera at\nSPaaS QR code",
                    fontSize = 14.sp,
                    color = Color.Gray,
                    textAlign = TextAlign.Center
                )
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onScanClick,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
        ) {
            Text("📷 Open Camera Scanner", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Divider
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Divider(modifier = Modifier.weight(1f), color = Color(0xFF334155))
            Text("  or paste code  ", fontSize = 12.sp, color = Color.Gray)
            Divider(modifier = Modifier.weight(1f), color = Color(0xFF334155))
        }

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = manualCode,
            onValueChange = { manualCode = it },
            label = { Text("Enrollment Code or URI") },
            placeholder = { Text("SP-A1B2 or spaas://pair?...", color = Color.Gray) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )

        Spacer(modifier = Modifier.height(12.dp))

        Button(
            onClick = { if (manualCode.isNotBlank()) onManualEntry(manualCode) },
            enabled = manualCode.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00E5FF))
        ) {
            Text("🔗 Enroll with Code", color = Color.Black, fontWeight = FontWeight.Bold)
        }

        Spacer(modifier = Modifier.height(16.dp))

        TextButton(onClick = onClose) {
            Text("← Back", color = Color.Gray)
        }
    }
}

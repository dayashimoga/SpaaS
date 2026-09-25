package dev.spaas.node

import dev.spaas.node.service.WasmRuntimeEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class WasmComputeTest {

    private val validWasmHeader = byteArrayOf(
        0x00.toByte(), 0x61.toByte(), 0x73.toByte(), 0x6D.toByte(),
        0x01.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte()
    )

    private val minimalValidModule = byteArrayOf(
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

    @Test
    fun testWasmBinaryValidation() {
        assertTrue(WasmRuntimeEngine.validateWasmBinary(validWasmHeader))
        assertTrue(WasmRuntimeEngine.validateWasmBinary(minimalValidModule))

        val invalidMagic = byteArrayOf(0x01, 0x02, 0x03, 0x04, 0x01, 0x00, 0x00, 0x00)
        assertFalse(WasmRuntimeEngine.validateWasmBinary(invalidMagic))

        val shortBytes = byteArrayOf(0x00, 0x61, 0x73)
        assertFalse(WasmRuntimeEngine.validateWasmBinary(shortBytes))
    }

    @Test
    fun testChallengeSha256Execution() {
        val testNonce = "android_edge_node_challenge_nonce_987654"
        val expectedDigest = MessageDigest.getInstance("SHA-256")
            .digest(testNonce.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

        val result = WasmRuntimeEngine.execute(
            wasmBytes = minimalValidModule,
            config = WasmRuntimeEngine.ExecutionConfig(
                maxFuel = 5_000_000L,
                args = listOf(testNonce)
            ),
            workloadName = "challenge-sha256"
        )

        assertEquals(0, result.exitCode)
        assertTrue(result.stdout.contains("Challenge SHA-256 Output: $expectedDigest"))
        assertNotNull(result.resultDigest)
        assertEquals(64, result.resultDigest.length)
        assertTrue(result.fuelConsumed > 0)
    }

    @Test
    fun testExecutionFuelMetering() {
        val result = WasmRuntimeEngine.execute(
            wasmBytes = minimalValidModule,
            config = WasmRuntimeEngine.ExecutionConfig(maxFuel = 10_000_000L),
            workloadName = "prime-sieve"
        )

        assertEquals(0, result.exitCode)
        assertTrue(result.fuelConsumed > 500_000L)
        assertTrue(result.stdout.contains("Primes Found"))
    }

    @Test(expected = WasmRuntimeEngine.OutOfFuelException::class)
    fun testOutOfFuelException() {
        WasmRuntimeEngine.execute(
            wasmBytes = minimalValidModule,
            config = WasmRuntimeEngine.ExecutionConfig(maxFuel = 5L),
            workloadName = "infinite-loop-test"
        )
    }
}

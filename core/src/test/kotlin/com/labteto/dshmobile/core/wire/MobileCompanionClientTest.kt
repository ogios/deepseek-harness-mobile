package com.labteto.dshmobile.core.wire

import java.io.InputStream
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileCompanionClientTest {

    private class Scripted(
        private val status: Int,
        private val body: String,
    ) : RpcTransport {
        var downloadPath: String? = null
        var uploadPath: String? = null
        var uploadType: String? = null
        var uploaded: ByteArray? = null

        override suspend fun post(path: String, body: String): RpcHttpResponse = error("unused")

        override suspend fun <T> download(
            path: String,
            consume: (String?, String?, InputStream) -> T,
        ): T {
            downloadPath = path
            if (status !in 200..299) throw RpcTransportException(status, "carrier returned HTTP $status")
            return consume(null, null, body.byteInputStream())
        }

        override suspend fun upload(
            path: String,
            contentType: String,
            contentLength: Long,
            body: InputStream,
            onProgress: ((Long) -> Unit)?,
        ): RpcHttpResponse {
            uploadPath = path
            uploadType = contentType
            uploaded = body.readBytes()
            if (status !in 200..299) throw RpcTransportException(status, "carrier returned HTTP $status")
            return RpcHttpResponse(status, this.body)
        }
    }

    @Test
    fun balanceParsesCurrencyAndHidesAMissingPlugin() = runTest {
        val ok = Scripted(
            200,
            """{"ok":true,"currency":"CNY","available":true,"balances":[{"currency":"CNY","total":"12.50","granted":"0.50","toppedUp":"12.00"}]}""",
        )
        val result = MobileCompanionClient(ok).balance()
        assertEquals(COMPANION_BALANCE_PATH, ok.downloadPath)
        val balance = (result as CompanionResult.Ok).value
        assertEquals("CNY", balance.currency)
        assertEquals("12.50", balance.balances.single().total)
        assertEquals("12.00", balance.balances.single().toppedUp)

        val missing = MobileCompanionClient(Scripted(404, "not found")).balance()
        assertEquals(CompanionResult.Unavailable, missing)
    }

    @Test
    fun balanceFailureKeepsThePluginMessage() = runTest {
        val result = MobileCompanionClient(
            Scripted(200, """{"ok":false,"error":{"code":"missing-key","message":"DEEPSEEK_API_KEY is not set in the harness environment"}}"""),
        ).balance()
        assertTrue(result is CompanionResult.Failed)
        assertEquals(
            "DEEPSEEK_API_KEY is not set in the harness environment",
            (result as CompanionResult.Failed).message,
        )
    }

    @Test
    fun transcribeUploadsAudioAndReturnsText() = runTest {
        val transport = Scripted(200, """{"ok":true,"text":"你好 hello"}""")
        val audio = byteArrayOf(1, 2, 3, 4)
        val result = MobileCompanionClient(transport).transcribe("audio/mp4", audio)
        assertEquals(COMPANION_TRANSCRIBE_PATH, transport.uploadPath)
        assertEquals("audio/mp4", transport.uploadType)
        assertTrue(audio.contentEquals(transport.uploaded))
        assertEquals("你好 hello", (result as CompanionResult.Ok).value)
    }

    @Test
    fun transcribeReportsAnAbsentRouteAndACommandFailure() = runTest {
        assertEquals(
            CompanionResult.Unavailable,
            MobileCompanionClient(Scripted(404, "not found")).transcribe("audio/wav", byteArrayOf(1)),
        )
        val failed = MobileCompanionClient(
            Scripted(200, """{"ok":false,"error":{"code":"transcribe-timeout","message":"command timed out after 120000ms"}}"""),
        ).transcribe("audio/wav", byteArrayOf(1))
        assertEquals("command timed out after 120000ms", (failed as CompanionResult.Failed).message)
    }
}

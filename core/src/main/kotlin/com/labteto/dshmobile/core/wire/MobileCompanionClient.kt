package com.labteto.dshmobile.core.wire

import java.io.InputStream
import kotlinx.serialization.Serializable

/** One currency row from the companion plugin's balance route. Amounts stay decimal strings. */
data class DeepSeekBalanceLine(
    val currency: String,
    val total: String,
    val granted: String,
    val toppedUp: String,
)

/** Account balance returned by `GET /api/dshMobile/balance`. */
data class DeepSeekBalance(
    val currency: String,
    val available: Boolean,
    val balances: List<DeepSeekBalanceLine>,
)

/**
 * Outcome of a companion-plugin call.
 *
 * [Unavailable] is a 404: the plugin is not installed, and the screen hides the control.
 * [Failed] is a reached route that could not do the work, with a message safe to show.
 */
sealed interface CompanionResult<out T> {
    data class Ok<T>(val value: T) : CompanionResult<T>
    data object Unavailable : CompanionResult<Nothing>
    data class Failed(val message: String) : CompanionResult<Nothing>
}

/** `POST /api/dshMobile/transcribe` — raw audio in, transcript text out. */
const val COMPANION_TRANSCRIBE_PATH: String = "/api/dshMobile/transcribe"

/** `GET /api/dshMobile/balance` — cached DeepSeek balance, no API key on the wire back. */
const val COMPANION_BALANCE_PATH: String = "/api/dshMobile/balance"

/**
 * The fork's companion routes, carried by the same [RpcTransport] as the harness API.
 *
 * Both paths sit under `/api`, so they pass the harness browser-session check and a relay that
 * already forwards `/api/`. A deployment without the plugin answers 404, which is
 * [CompanionResult.Unavailable] rather than a broken connection.
 */
class MobileCompanionClient(
    private val transport: RpcTransport,
) {
    suspend fun balance(): CompanionResult<DeepSeekBalance> = try {
        val body = transport.download(COMPANION_BALANCE_PATH) { _, _, stream -> stream.readTextSafe() }
        parseBalance(body)
    } catch (e: RpcTransportException) {
        transportFailure(e)
    }

    suspend fun transcribe(contentType: String, bytes: ByteArray): CompanionResult<String> = try {
        val response = transport.upload(
            COMPANION_TRANSCRIBE_PATH,
            contentType,
            bytes.size.toLong(),
            bytes.inputStream(),
        )
        parseTranscript(response.body)
    } catch (e: RpcTransportException) {
        transportFailure(e)
    }

    private fun transportFailure(error: RpcTransportException): CompanionResult<Nothing> =
        if (error.status == 404) CompanionResult.Unavailable
        else CompanionResult.Failed(error.message ?: "request failed")
}

private fun InputStream.readTextSafe(): String = bufferedReader().use { it.readText() }

@Serializable
private data class CompanionWire(
    val ok: Boolean = false,
    val text: String? = null,
    val currency: String = "",
    val available: Boolean = true,
    val balances: List<CompanionBalanceWire> = emptyList(),
    val error: CompanionErrorWire? = null,
)

@Serializable
private data class CompanionBalanceWire(
    val currency: String = "",
    val total: String = "",
    val granted: String = "",
    val toppedUp: String = "",
)

@Serializable
private data class CompanionErrorWire(
    val code: String = "",
    val message: String = "",
)

private fun parseBalance(body: String): CompanionResult<DeepSeekBalance> {
    val wire = decode(body) ?: return CompanionResult.Failed("balance response was not valid")
    if (!wire.ok) return CompanionResult.Failed(wire.error?.message?.ifBlank { null } ?: "balance unavailable")
    val lines = wire.balances.mapNotNull { row ->
        if (row.currency.isBlank()) null
        else DeepSeekBalanceLine(row.currency, row.total, row.granted, row.toppedUp)
    }
    if (lines.isEmpty()) return CompanionResult.Failed("balance response had no balances")
    return CompanionResult.Ok(DeepSeekBalance(wire.currency.ifBlank { lines.first().currency }, wire.available, lines))
}

private fun parseTranscript(body: String): CompanionResult<String> {
    val wire = decode(body) ?: return CompanionResult.Failed("transcription response was not valid")
    if (!wire.ok) return CompanionResult.Failed(wire.error?.message?.ifBlank { null } ?: "transcription failed")
    return CompanionResult.Ok(wire.text.orEmpty())
}

private fun decode(body: String): CompanionWire? = try {
    WireJson.decodeFromString(CompanionWire.serializer(), body)
} catch (_: Exception) {
    null
}

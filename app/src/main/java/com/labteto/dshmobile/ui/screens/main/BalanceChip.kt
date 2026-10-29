package com.labteto.dshmobile.ui.screens.main

import com.labteto.dshmobile.core.wire.DeepSeekBalance

/** What the chat bar shows for the companion balance route. [warn] is a failed or empty account. */
internal data class BalanceChipUi(val text: String, val warn: Boolean)

/**
 * A short amount for the chip: the first non-zero total, otherwise the first row.
 *
 * CNY, USD and EUR pick a symbol. Anything else keeps the currency code, because a
 * wrong symbol is worse than a short code.
 */
internal fun formatBalanceAmount(balance: DeepSeekBalance): String {
    val primary = balance.balances.firstOrNull { line ->
        line.total.toDoubleOrNull()?.let { it != 0.0 } == true
    } ?: balance.balances.firstOrNull()
    if (primary == null) return balance.currency
    val amount = primary.total.ifBlank { "0" }
    val symbol = when (primary.currency.uppercase()) {
        "CNY", "RMB" -> "¥"
        "USD" -> "$"
        "EUR" -> "€"
        else -> null
    }
    return if (symbol == null) "${primary.currency} $amount" else symbol + amount
}

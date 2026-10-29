package com.labteto.dshmobile.ui.screens.main

import com.labteto.dshmobile.core.wire.DeepSeekBalance
import com.labteto.dshmobile.core.wire.DeepSeekBalanceLine
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceAndBalanceTest {

    @Test
    fun transcriptInsertsAtTheCaretAndSeparatesWords() {
        assertEquals("你好 hello" to 8, insertTranscript("", 0, "  你好 hello  "))
        assertEquals("fix 你好 hello this" to 12, insertTranscript("fix this", 3, "你好 hello"))
        assertEquals("你好 hello already" to 8, insertTranscript("already", 0, "你好 hello"))
        assertEquals("keep" to 4, insertTranscript("keep", 4, "   "))
    }

    @Test
    fun balanceChipPrefersANonZeroTotalAndAKnownSymbol() {
        val balance = DeepSeekBalance(
            currency = "CNY",
            available = true,
            balances = listOf(
                DeepSeekBalanceLine("USD", "0", "0", "0"),
                DeepSeekBalanceLine("CNY", "12.50", "0.50", "12.00"),
            ),
        )
        assertEquals("¥12.50", formatBalanceAmount(balance))
        assertEquals(
            "$3.00",
            formatBalanceAmount(
                DeepSeekBalance(currency = "USD", available = false, balances = listOf(DeepSeekBalanceLine("USD", "3.00", "0", "3.00"))),
            ),
        )
        assertEquals(
            "JPY 10",
            formatBalanceAmount(
                DeepSeekBalance(currency = "JPY", available = true, balances = listOf(DeepSeekBalanceLine("JPY", "10", "0", "10"))),
            ),
        )
    }
}

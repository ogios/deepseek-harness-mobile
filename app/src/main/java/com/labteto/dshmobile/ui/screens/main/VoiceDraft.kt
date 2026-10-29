package com.labteto.dshmobile.ui.screens.main

/** Where a dictate action is, so the composer can show recording without owning the recorder. */
internal enum class DictationPhase { Idle, Recording, Transcribing }

/**
 * Insert a transcript into a draft at [cursor].
 *
 * A blank transcript leaves the draft alone. Words that would otherwise run into
 * the surrounding text gain a single separating space. The caret ends after the
 * inserted words so the reader can keep editing.
 */
internal fun insertTranscript(draft: String, cursor: Int, transcript: String): Pair<String, Int> {
    val text = transcript.trim()
    if (text.isEmpty()) return draft to cursor.coerceIn(0, draft.length)
    val at = cursor.coerceIn(0, draft.length)
    val before = draft.substring(0, at)
    val after = draft.substring(at)
    val prefix = if (before.isNotEmpty() && !before.last().isWhitespace()) " " else ""
    val suffix = if (after.isNotEmpty() && !after.first().isWhitespace()) " " else ""
    val next = before + prefix + text + suffix + after
    return next to (before.length + prefix.length + text.length)
}

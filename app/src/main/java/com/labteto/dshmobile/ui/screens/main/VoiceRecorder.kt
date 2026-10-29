package com.labteto.dshmobile.ui.screens.main

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * One microphone take, stored in the app cache until the caller uploads or drops it.
 *
 * AAC in an MPEG-4 file is the first choice. Devices that refuse that encoder fall
 * back to AMR in 3GPP, which ffmpeg on the harness still converts to 16 kHz mono WAV.
 */
internal class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null

    /** Start a new take, replacing any take still open. False when the device could not record. */
    fun start(): Boolean {
        discard()
        val aac = File(context.cacheDir, "dictate-${System.nanoTime()}.m4a")
        if (startWith(aac, mpeg = true)) return true
        aac.delete()
        val amr = File(context.cacheDir, "dictate-${System.nanoTime()}.3gp")
        if (startWith(amr, mpeg = false)) return true
        amr.delete()
        return false
    }

    /** Finish the take. Null when it never started or stopped before any audio was stored. */
    fun stop(): File? {
        val current = recorder ?: return null
        val out = file
        recorder = null
        file = null
        val stopped = try {
            current.stop()
            true
        } catch (_: RuntimeException) {
            false
        } finally {
            runCatching { current.release() }
        }
        if (!stopped || out == null || !out.exists() || out.length() == 0L) {
            out?.delete()
            return null
        }
        return out
    }

    /** Drop an open take, including one that is still recording. */
    fun discard() {
        val current = recorder
        val out = file
        recorder = null
        file = null
        if (current != null) {
            runCatching { current.stop() }
            runCatching { current.release() }
        }
        out?.delete()
    }

    @Suppress("DEPRECATION")
    private fun startWith(out: File, mpeg: Boolean): Boolean {
        val created = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        return try {
            created.setAudioSource(MediaRecorder.AudioSource.MIC)
            if (mpeg) {
                created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                created.setAudioSamplingRate(16_000)
            } else {
                created.setOutputFormat(MediaRecorder.OutputFormat.THREE_GPP)
                created.setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB)
            }
            created.setAudioChannels(1)
            created.setOutputFile(out.absolutePath)
            created.prepare()
            created.start()
            recorder = created
            file = out
            true
        } catch (_: RuntimeException) {
            runCatching { created.release() }
            false
        }
    }
}

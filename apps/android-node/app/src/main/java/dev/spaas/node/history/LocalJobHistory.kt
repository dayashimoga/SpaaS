package dev.spaas.node.history

import org.json.JSONArray
import org.json.JSONObject

data class LocalJobHistoryEntry(
    val jobId: String,
    val workloadName: String,
    val startedAtMs: Long,
    val completedAtMs: Long,
    val exitCode: Int,
    val fuelConsumed: Long,
    val wallTimeMs: Long,
    val resultDigest: String,
    val isSuccess: Boolean
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("jobId", jobId)
        put("workloadName", workloadName)
        put("startedAtMs", startedAtMs)
        put("completedAtMs", completedAtMs)
        put("exitCode", exitCode)
        put("fuelConsumed", fuelConsumed)
        put("wallTimeMs", wallTimeMs)
        put("resultDigest", resultDigest)
        put("isSuccess", isSuccess)
    }

    companion object {
        fun fromJson(json: JSONObject): LocalJobHistoryEntry = LocalJobHistoryEntry(
            jobId = json.optString("jobId", ""),
            workloadName = json.optString("workloadName", "Job"),
            startedAtMs = json.optLong("startedAtMs", 0L),
            completedAtMs = json.optLong("completedAtMs", 0L),
            exitCode = json.optInt("exitCode", 0),
            fuelConsumed = json.optLong("fuelConsumed", 0L),
            wallTimeMs = json.optLong("wallTimeMs", 0L),
            resultDigest = json.optString("resultDigest", ""),
            isSuccess = json.optBoolean("isSuccess", true)
        )
    }
}

object LocalJobHistoryRepository {
    private val history = mutableListOf<LocalJobHistoryEntry>()
    private var isInitialized = false

    fun init(context: android.content.Context) {
        if (isInitialized) return
        isInitialized = true
        try {
            val prefs = context.getSharedPreferences("spaas_job_history", android.content.Context.MODE_PRIVATE)
            val jsonStr = prefs.getString("entries", null)
            if (!jsonStr.isNullOrBlank()) {
                val arr = JSONArray(jsonStr)
                synchronized(this) {
                    for (i in 0 until arr.length()) {
                        history.add(LocalJobHistoryEntry.fromJson(arr.getJSONObject(i)))
                    }
                }
            }
        } catch (_: Throwable) {}
    }

    private fun persist(context: android.content.Context?) {
        if (context == null) return
        try {
            val prefs = context.getSharedPreferences("spaas_job_history", android.content.Context.MODE_PRIVATE)
            val arr = JSONArray()
            synchronized(this) {
                for (entry in history.take(50)) {
                    arr.put(entry.toJson())
                }
            }
            prefs.edit().putString("entries", arr.toString()).apply()
        } catch (_: Throwable) {}
    }

    @Synchronized
    fun addEntry(entry: LocalJobHistoryEntry, context: android.content.Context? = null) {
        history.add(0, entry)
        if (history.size > 200) {
            history.removeAt(history.lastIndex)
        }
        persist(context ?: dev.spaas.node.service.ComputeWorkerClient.appContext)
    }

    @Synchronized
    fun getRecent(limit: Int = 20): List<LocalJobHistoryEntry> {
        return history.take(limit).toList()
    }

    @Synchronized
    fun totalCompleted(): Int = history.count { it.isSuccess }

    @Synchronized
    fun totalFailed(): Int = history.count { !it.isSuccess }

    @Synchronized
    fun removeEntry(jobId: String, context: android.content.Context? = null) {
        history.removeAll { it.jobId == jobId }
        persist(context ?: dev.spaas.node.service.ComputeWorkerClient.appContext)
    }

    @Synchronized
    fun clearHistory(context: android.content.Context? = null) {
        history.clear()
        persist(context ?: dev.spaas.node.service.ComputeWorkerClient.appContext)
    }
}

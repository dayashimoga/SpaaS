package dev.spaas.node.history

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
)

object LocalJobHistoryRepository {
    private val history = mutableListOf<LocalJobHistoryEntry>()

    @Synchronized
    fun addEntry(entry: LocalJobHistoryEntry) {
        history.add(0, entry)
        if (history.size > 200) {
            history.removeAt(history.lastIndex)
        }
    }

    @Synchronized
    fun getRecent(limit: Int = 20): List<LocalJobHistoryEntry> {
        return history.take(limit).toList()
    }

    @Synchronized
    fun totalCompleted(): Int = history.count { it.isSuccess }

    @Synchronized
    fun totalFailed(): Int = history.count { !it.isSuccess }
}

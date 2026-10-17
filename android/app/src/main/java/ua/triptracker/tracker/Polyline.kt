package ua.triptracker.tracker

/** Одна точка маршруту. */
data class TrackPoint(
    val lat: Double,
    val lon: Double,
    val time: Long,     // unix ms
    val speed: Float,   // км/г
    val accuracy: Float // m
) {
    /** Координати в форматі, який чекає сервер: "50.450100, 30.523400". */
    fun coords(): String = String.format("%.6f, %.6f", lat, lon)
}

/** Кодування маршруту в Google polyline (той же алгоритм, що на вебі). */
object Polyline {

    fun encode(points: List<TrackPoint>): String {
        if (points.isEmpty()) return ""
        var lastLat = 0
        var lastLng = 0
        val sb = StringBuilder()

        for (p in points) {
            val lat = Math.round(p.lat * 1e5).toInt()
            val lng = Math.round(p.lon * 1e5).toInt()
            encodeNumber(lat - lastLat, sb)
            encodeNumber(lng - lastLng, sb)
            lastLat = lat
            lastLng = lng
        }
        return sb.toString()
    }

    private fun encodeNumber(num: Int, sb: StringBuilder) {
        var value = if (num < 0) (num shl 1).inv() else num shl 1
        while (value >= 0x20) {
            sb.append(((0x20 or (value and 0x1f)) + 63).toChar())
            value = value shr 5
        }
        sb.append((value + 63).toChar())
    }
}

/** Сегмент маршруту готовий до відправки. */
data class TrackSegment(
    val mode: String,          // drive | walk | still | nosignal
    val startedAt: Long,
    val endedAt: Long,
    val distanceM: Long,
    val points: List<TrackPoint>,
    val pauseRecordId: Int? = null   // якщо це ходьба під час паузи
) {
    val locationLat: Double get() = points.firstOrNull()?.lat ?: 0.0
    val locationLon: Double get() = points.firstOrNull()?.lon ?: 0.0
    val durationSec: Long get() = ((endedAt - startedAt) / 1000).coerceAtLeast(0)

    /**
     * @param suffix робить унікальним uuid для повторно надісланого сегмента
     *               (сервер не створить дубль за client_uuid)
     */
    fun toJson(suffix: String = ""): org.json.JSONObject {
        val json = org.json.JSONObject().apply {
            put("mode", mode)
            put("started_at", startedAt)
            put("ended_at", endedAt)
            put("distance_m", distanceM)
            put("points", points.size)
            put("polyline", Polyline.encode(points))
            put("client_uuid", "seg-$startedAt$suffix")
        }
        if (pauseRecordId != null && pauseRecordId > 0) put("pause_record_id", pauseRecordId)
        return json
    }
}

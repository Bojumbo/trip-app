package ua.triptracker.tracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Фоновий трекер рейсу.
 *
 * Виявляє зупинки (зміщення < 50 м за N хвилин), питає чи це пауза,
 * і після відновлення руху авто (>15 км/г) створює запис «Продовження руху».
 * Під час паузи будь-яке переміщення вважається ходьбою.
 */
class TrackerService : Service() {

    companion object {
        const val ACTION_START = "ua.triptracker.tracker.START"
        const val ACTION_STOP = "ua.triptracker.tracker.STOP"
        const val ACTION_SKIP_PAUSE = "ua.triptracker.tracker.SKIP_PAUSE"
        const val ACTION_PAUSE_CONFIRMED = "ua.triptracker.tracker.PAUSE_CONFIRMED"
        const val EXTRA_RECORD_ID = "record_id"

        private const val NOTIF_ID = 1
        private const val NOTIF_PAUSE_ID = 2
        private const val CHANNEL_TRACK = "tracker_channel"
        private const val CHANNEL_PAUSE = "pause_channel"

        private const val RESUME_SPEED_KMH = 15f
        private const val RESUME_HOLD_MS = 60_000L
        private const val LOCATION_INTERVAL_MS = 30_000L
        private const val MIN_ACCURACY_M = 80f
        private const val STOP_RADIUS_M = 50.0
        private const val MAX_SEGMENT_POINTS = 400
        private const val MAX_PENDING_SEGMENTS = 200

        fun start(context: Context) {
            val intent = Intent(context, TrackerService::class.java).apply { action = ACTION_START }
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, TrackerService::class.java).apply { action = ACTION_STOP })
        }

        fun skipPause(context: Context) {
            context.startService(Intent(context, TrackerService::class.java).apply { action = ACTION_SKIP_PAUSE })
        }

        fun pauseConfirmed(context: Context, recordId: Int) {
            context.startService(
                Intent(context, TrackerService::class.java).apply {
                    action = ACTION_PAUSE_CONFIRMED
                    putExtra(EXTRA_RECORD_ID, recordId)
                }
            )
        }
    }

    private lateinit var prefs: Prefs
    private lateinit var api: ApiClient
    private lateinit var notifications: NotificationManager

    private val worker = Executors.newSingleThreadExecutor()
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }

    /** Поточна точка збереження треку. */
    private enum class SaveState { IDLE, TRACKING }
    private var saveState = SaveState.IDLE

    /** Стан зупинки: null — рухів немає, інакше час початку. */
    private var stoppedSince = 0L
    private var movingFastSince = 0L
    private var lastFixAt = 0L
    private var lastLat = 0.0
    private var lastLon = 0.0
    private var hasPosition = false
    private var pauseNotified = false

    /** Чи відкритий рейс і зміна. */
    private var tripActive = false
    private var lastTripCheckAt = 0L
    private var locationsAttached = false

    /** Поточна пауза (null — паузи немає). */
    private class ActivePause(
        val startedAt: Long,
        val lat: Double,
        val lon: Double,
        val odometer: Int,
        var recordId: Int
    )
    private var pause: ActivePause? = null

    /** Черга серіалізованих сегментів на відправку. */
    private val pendingJson = ArrayDeque<String>()
    private var segmentMode = ""
    private val segmentPoints = mutableListOf<TrackPoint>()
    private var segmentStartedAt = 0L
    private var segmentDistance = 0L

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let(::handleLocation)
        }
    }

    // ---------------- Життєвий цикл ----------------

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        api = ApiClient(prefs)
        notifications = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        createChannels()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                buildTrackerNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIF_ID, buildTrackerNotification())
        }

        restoreQueue()
        worker.execute(::checkTripAndSync)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> prefs.trackingEnabled = true
            ACTION_STOP -> {
                prefs.trackingEnabled = false
                flushSegments()
                stopSelf()
            }
            ACTION_SKIP_PAUSE -> {
                dismissedStop = System.currentTimeMillis()
                notifications.cancel(NOTIF_PAUSE_ID)
                pauseNotified = false
                updateTrackerNotification()
            }
            ACTION_PAUSE_CONFIRMED -> {
                notifications.cancel(NOTIF_PAUSE_ID)
                val recordId = intent.getIntExtra(EXTRA_RECORD_ID, 0)
                confirmPause(recordId)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        fused.removeLocationUpdates(locationCallback)
        flushSegments()
        worker.shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private var dismissedStop = 0L

    // ---------------- Локація ----------------

    private fun requestLocations() {
        val request = LocationRequest.create().apply {
            interval = LOCATION_INTERVAL_MS
            fastestInterval = LOCATION_INTERVAL_MS / 2
            priority = LocationRequest.PRIORITY_BALANCED_POWER_ACCURACY
            maxWaitTime = LOCATION_INTERVAL_MS * 2
        }
        try {
            fused.requestLocationUpdates(request, locationCallback, android.os.Looper.getMainLooper())
            locationsAttached = true
        } catch (e: SecurityException) {
            // дозволів немає — сервіс чекатиме, поки їх дадуть
        }
    }

    private fun handleLocation(location: Location) {
        lastFixAt = System.currentTimeMillis()
        if (location.accuracy > MIN_ACCURACY_M) return //мітка недостовірна, не маршрут

        val now = lastFixAt
        val speed = if (location.hasSpeed()) location.speed * 3.6f else 0f

        addPoint(TrackPoint(location.latitude, location.longitude, now, speed, location.accuracy))

        // швидкісний рух
        if (speed > RESUME_SPEED_KMH) {
            if (movingFastSince == 0L) movingFastSince = now
        } else {
            movingFastSince = 0L
        }

        // зміщення від останньої позиції
        var moved = false
        if (hasPosition) {
            val d = distanceMeters(now, location.latitude, location.longitude)
            if (d > 25) moved = true
        }
        lastLat = location.latitude
        lastLon = location.longitude
        hasPosition = true

        if (moved) {
            stoppedSince = 0L
        } else if (stoppedSince == 0L) {
            stoppedSince = now
        }

        applyState(now)
        maybeFlush(now)
    }

    private fun distanceMeters(now: Long, lat: Double, lon: Double): Double {
        if (!hasPosition) return Double.MAX_VALUE
        val results = FloatArray(1)
        Location.distanceBetween(lastLat, lastLon, lat, lon, results)
        return results[0].toDouble()
    }

    // ---------------- Стан-машина ----------------

    private fun applyState(now: Long) {
        val currentPause = pause

        // 1. Відновлення руху після паузи — пишемо «Продовження руху»
        if (currentPause != null && movingFastSince != 0L && now - movingFastSince >= RESUME_HOLD_MS) {
            closePause(currentPause)
            pause = null
            stoppedSince = 0L
            movingFastSince = 0L
            return
        }

        // 2. Під час паузи будь-який рух — це ходьба, стан не змінюємо
        if (currentPause != null) return

        // 3. Виявлення зупинки
        val thresholdMs = prefs.stopMinutes.coerceIn(2, 30) * 60_000L
        if (stoppedSince != 0L && now - stoppedSince >= thresholdMs && !pauseNotified && now - dismissedStop > thresholdMs) {
            pauseNotified = true
            showPausePrompt(lastLat, lastLon)
        }
    }

    /** Користувач підтвердив паузу в застосунку (вже створений запис). */
    private fun confirmPause(recordId: Int) {
        if (recordId <= 0) return
        pause = ActivePause(
            startedAt = System.currentTimeMillis(),
            lat = lastLat,
            lon = lastLon,
            odometer = prefs.lastOdometer,
            recordId = recordId
        )
        pauseNotified = false
        updateTrackerNotification()
    }

    private fun closePause(activePause: ActivePause) {
        val body = JSONObject().apply {
            put("date", IsoDate.now())
            put("time", IsoDate.time())
            put("action", "Продовження руху")
            put("location", "")
            put("comment", "авто: рух відновлено після паузи")
            put("coords", "$lastLat, $lastLon")
            put("source", "auto")
            put("client_uuid", "res-${activePause.startedAt}")
        }

        worker.execute {
            api.post("/api/records", body)
            // якщо не вдалось, повтор не потрібен: відсутність запису після паузи
            // менша проблема, ніж дубль
            updateTrackerNotification()
        }
    }

    // ---------------- Сегменти ----------------

    private fun currentMode(): String = when {
        pause != null -> "walk"
        System.currentTimeMillis() - lastFixAt > 2 * 60_000L -> "nosignal"
        else -> "drive"
    }

    private fun addPoint(point: TrackPoint) {
        if (segmentPoints.isEmpty()) {
            segmentMode = currentMode()
            segmentStartedAt = point.time
        } else if (segmentMode != currentMode() || segmentPoints.size >= MAX_SEGMENT_POINTS) {
            closeSegment()
            segmentMode = currentMode()
            segmentStartedAt = point.time
        }

        if (segmentPoints.isNotEmpty()) {
            val prev = segmentPoints.last()
            val results = FloatArray(1)
            Location.distanceBetween(prev.lat, prev.lon, point.lat, point.lon, results)
            segmentDistance += results[0].roundToInt().toLong()
        }
        segmentPoints.add(point)
    }

    private fun closeSegment() {
        if (segmentPoints.isEmpty()) return
        val segment = TrackSegment(
            mode = segmentMode,
            startedAt = segmentStartedAt,
            endedAt = segmentPoints.last().time,
            distanceM = segmentDistance,
            points = segmentPoints.toList(),
            pauseRecordId = pause?.takeIf { segmentMode == "walk" }?.recordId
        )
        pendingJson.addLast(segment.toJson().toString())
        while (pendingJson.size > MAX_PENDING_SEGMENTS) pendingJson.removeFirst()

        segmentPoints.clear()
        segmentDistance = 0L
    }

    private fun maybeFlush(now: Long) {
        val lastAt = lastFlushAt
        if (segmentPoints.size >= MAX_SEGMENT_POINTS || (now - lastAt > 5 * 60_000L && pendingJson.size < MAX_PENDING_SEGMENTS)) {
            flushSegments()
        }
    }

    private var lastFlushAt = 0L

    private fun flushSegments() {
        lastFlushAt = System.currentTimeMillis()
        closeSegment()
        if (pendingJson.isEmpty()) { persistQueue(); return }

        val batch = pendingJson.take(20)
        val segments = batch.joinToString(",", "[", "]") { it }

        worker.execute {
            when (val result = api.post("/api/track/segments", JSONObject("{\"segments\":$segments}"))) {
                is ApiResult.Ok -> {
                    val body = JSONObject(result.body)
                    val sent = body.optInt("saved", batch.size)
                    repeat(sent) { if (pendingJson.isNotEmpty()) pendingJson.removeFirst() }
                }
                is ApiResult.Err -> {
                    // немає активного рейсу чи доступу — очищаємо, щоб черга не росла
                    if (result.code == 409 || result.code == 401 || result.code == 403) {
                        repeat(batch.size) { if (pendingJson.isNotEmpty()) pendingJson.removeFirst() }
                    }
                }
                ApiResult.Offline -> Unit
            }
            persistQueue()
            updateTrackerNotification()
        }
    }

    // ---------------- Черга ----------------

    private fun queueFile() = java.io.File(filesDir, "segments_queue.jsonl")

    private fun persistQueue() {
        try {
            queueFile().writeText(pendingJson.joinToString("\n"))
        } catch (e: Exception) {
            // запис черги не критичний
        }
    }

    private fun restoreQueue() {
        val file = queueFile()
        if (!file.exists()) return
        try {
            file.readLines().filter { it.isNotBlank() }.forEach { line ->
                val obj = org.json.JSONObject(line)
                pendingJson.addLast(obj.toString())
            }
        } catch (e: Exception) {
            // пошкоджену чергу ігноруємо
        }
    }

    // ---------------- Синхронізація стану ----------------

    private fun checkTripAndSync() {
        while (prefs.trackingEnabled) {
            val active = checkTrip()
            if (active) {
                tripActive = true
                if (!locationsAttached) { requestLocations(); locationsAttached = true }
                if (pendingJson.isNotEmpty()) flushSegments()
            } else {
                tripActive = false
                if (locationsAttached) {
                    fused.removeLocationUpdates(locationCallback)
                    locationsAttached = false
                    closeSegment()
                    persistQueue()
                }
            }
            updateTrackerNotification()
            lastTripCheckAt = System.currentTimeMillis()
            SystemClock.sleep(30_000L)
        }
    }

    private fun checkTrip(): Boolean {
        if (prefs.serverUrl.isBlank() || prefs.deviceToken.isBlank()) return false
        return try {
            val result = api.get("/api/devices/me")
            if (result is ApiResult.Ok) {
                val obj = JSONObject(result.body)
                val trip = obj.optJSONObject("activeTrip")
                if (trip != null) {
                    prefs.lastOdometer = trip.optInt("start_odometer")
                    syncLastOdometer(obj)
                }
                trip != null
            } else false
        } catch (e: Exception) {
            false
        }
    }

    private fun syncLastOdometer(me: JSONObject) {
        val last = me.optInt("lastOdometer", 0)
        if (last > 0) prefs.lastOdometer = last
    }

    // ---------------- Сповіщення ----------------

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val track = NotificationChannel(
                CHANNEL_TRACK, getString(R.string.channel_tracker), NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
            val pause = NotificationChannel(
                CHANNEL_PAUSE, getString(R.string.channel_pause), NotificationManager.IMPORTANCE_HIGH
            )
            notifications.createNotificationChannel(track)
            notifications.createNotificationChannel(pause)
        }
    }

    private fun buildTrackerNotification(): Notification {
        val open = Intent(this, MainActivity::class.java)
        val contentIntent = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val text = when {
            prefs.serverUrl.isBlank() || prefs.deviceToken.isBlank() -> "Налаштуйте адресу та токен"
            pause != null -> "Пауза — рух пішки фіксується"
            tripActive -> "Трекінг активний" + if (pendingJson.isNotEmpty()) " · у черзі ${pendingJson.size}" else ""
            else -> "Очікування відкритого рейсу"
        }

        return NotificationCompat.Builder(this, CHANNEL_TRACK)
            .setSmallIcon(R.drawable.ic_stat_truck)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(contentIntent)
            .build()
    }

    private fun showPausePrompt(lat: Double, lon: Double) {
        val confirmIntent = Intent(this, MainActivity::class.java).apply {
            action = MainActivity.ACTION_SHOW_PAUSE_DIALOG
            putExtra(MainActivity.EXTRA_LAT, lat)
            putExtra(MainActivity.EXTRA_LON, lon)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val confirmPending = PendingIntent.getActivity(
            this, 2, confirmIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val skipIntent = Intent(this, TrackerService::class.java).apply { action = ACTION_SKIP_PAUSE }
        val skipPending = PendingIntent.getService(
            this, 3, skipIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_PAUSE)
            .setSmallIcon(R.drawable.ic_stat_truck)
            .setContentTitle(getString(R.string.notif_stop_title))
            .setContentText("Зупинка ${prefs.stopMinutes} хв. Це пауза?")
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, getString(R.string.pause_yes), confirmPending)
            .addAction(0, getString(R.string.pause_no), skipPending)
            .build()

        try {
            notifications.notify(NOTIF_PAUSE_ID, notification)
        } catch (e: SecurityException) {
            // дозвіл на сповіщення не наданий
        }
    }

    private fun updateTrackerNotification() {
        try {
            notifications.notify(NOTIF_ID, buildTrackerNotification())
        } catch (e: Exception) {
            // сервіс уже зупинений
        }
    }
}

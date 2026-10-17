package ua.triptracker.tracker

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import android.text.InputType
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    companion object {
        const val ACTION_SHOW_PAUSE_DIALOG = "ua.triptracker.tracker.SHOW_PAUSE_DIALOG"
        const val EXTRA_LAT = "lat"
        const val EXTRA_LON = "lon"
    }

    private lateinit var prefs: Prefs
    private lateinit var api: ApiClient

    private val etServer by lazy { findViewById<EditText>(R.id.etServer) }
    private val etToken by lazy { findViewById<EditText>(R.id.etToken) }
    private val etName by lazy { findViewById<EditText>(R.id.etName) }
    private val etStop by lazy { findViewById<EditText>(R.id.etStopMinutes) }
    private val btnToggle by lazy { findViewById<Button>(R.id.btnToggle) }
    private val btnPermissions by lazy { findViewById<Button>(R.id.btnPermissions) }
    private val tvStatus by lazy { findViewById<TextView>(R.id.tvStatus) }
    private val tvQueue by lazy { findViewById<TextView>(R.id.tvQueue) }

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            updateStatus()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = Prefs(this)
        api = ApiClient(prefs)

        etServer.setText(prefs.serverUrl)
        etToken.setText(prefs.deviceToken)
        etName.setText(prefs.deviceName)
        etStop.setText(prefs.stopMinutes.toString())

        btnToggle.setOnClickListener { toggleTracking() }
        btnPermissions.setOnClickListener { requestAllPermissions() }

        handleIntent(intent)
        updateStatus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        savePrefs()
        updateStatus()
    }

    private fun savePrefs() {
        prefs.serverUrl = etServer.text.toString()
        prefs.deviceToken = etToken.text.toString()
        prefs.deviceName = etName.text.toString().ifBlank { "Телефон водія" }
        etStop.text.toString().toIntOrNull()?.let { prefs.stopMinutes = it }
    }

    private fun toggleTracking() {
        savePrefs()

        if (prefs.serverUrl.isBlank() || prefs.deviceToken.isBlank()) {
            showStatus("Вкажіть адресу сервера та токен пристрою")
            return
        }

        if (!hasLocationPermission()) {
            requestAllPermissions()
            return
        }

        if (prefs.trackingEnabled) {
            TrackerService.stop(this)
            prefs.trackingEnabled = false
            btnToggle.text = "Увімкнути трекінг"
        } else {
            TrackerService.start(this)
            prefs.trackingEnabled = true
            btnToggle.text = "Вимкнути трекінг"
        }
        updateStatus()
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestAllPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            permissions += Manifest.permission.ACCESS_BACKGROUND_LOCATION
        }
        locationPermissionLauncher.launch(permissions.toTypedArray())
        askIgnoreBatteryOptimization()
    }

    /** Без цього система може вбити сервіс під час паузи. */
    private fun askIgnoreBatteryOptimization() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (e: Exception) {
            // на деяких пристроях діалога немає — це не критично
        }
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == ACTION_SHOW_PAUSE_DIALOG) {
            val lat = intent.getDoubleExtra(EXTRA_LAT, 0.0)
            val lon = intent.getDoubleExtra(EXTRA_LON, 0.0)
            showPauseDialog(lat, lon)
        }
    }

    /**
     * Запит одометра в момент зупинки: водій стоїть і може подивитись на панель.
     * Після відправки створюється запис «Пауза» з джерелом auto.
     */
    private fun showPauseDialog(lat: Double, lon: Double) {
        savePrefs()

        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(prefs.lastOdometer.takeIf { it > 0 }?.toString() ?: "")
            hint = "Одометр, км"
        }

        var answered = false

        AlertDialog.Builder(this)
            .setTitle("Це пауза?")
            .setMessage("Одометр зараз (можна виправити пізніше)")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Записати паузу") { _, _ ->
                answered = true
                submitPause(input.text.toString().toIntOrNull() ?: 0, lat, lon)
            }
            .setNegativeButton("Не пауза") { _, _ ->
                answered = true
                TrackerService.skipPause(this)
            }
            .setOnDismissListener { if (!answered) TrackerService.skipPause(this) }
            .show()
    }

    private fun submitPause(odometer: Int, lat: Double, lon: Double) {
        val coords = String.format("%.6f, %.6f", lat, lon)
        val body = JSONObject().apply {
            put("date", IsoDate.now())
            put("time", IsoDate.time())
            put("action", "Пауза")
            put("odometer", if (odometer > 0) odometer else JSONObject.NULL)
            put("location", "")
            put("comment", "авто: зупинка ${prefs.stopMinutes} хв")
            put("coords", coords)
            put("source", "auto")
            put("client_uuid", "pause-${System.currentTimeMillis()}")
        }

        Thread {
            when (val result = api.post("/api/records", body)) {
                is ApiResult.Ok -> {
                    val recordId = JSONObject(result.body).optInt("id")
                    if (recordId > 0) prefs.lastOdometer = odometer
                    runOnUiThread {
                        TrackerService.pauseConfirmed(this, recordId)
                        updateStatus()
                    }
                }
                is ApiResult.Err -> runOnUiThread {
                    showStatus("Не вдалось записати паузу: ${result.message}")
                }
                ApiResult.Offline -> runOnUiThread {
                    showStatus("Немає зв'язку — спробуйте ще раз при появі мережі")
                }
            }
        }.start()
    }

    private fun updateStatus() {
        btnToggle.text = if (prefs.trackingEnabled) "Вимкнути трекінг" else "Увімкнути трекінг"

        val permText = when {
            !hasLocationPermission() -> "❌ дозвіл на геолокацію не наданий"
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED -> "⚠️ дозвіл на сповіщення не наданий"
            prefs.trackingEnabled -> "✅ трекінг увімкнено, запис піде в активний рейс"
            else -> "⏸ трекінг вимкнено"
        }

        tvStatus.text = buildString {
            append(permText)
            append("\n")
            append(if (prefs.deviceToken.isNotBlank()) "токен: вказано" else "токен: не вказано")
        }

        val deviceName = prefs.deviceName
        tvQueue.text = "пристрій: $deviceName · поріг зупинки: ${prefs.stopMinutes} хв"
    }

    private fun showStatus(text: String) {
        tvStatus.text = text
        Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    }
}

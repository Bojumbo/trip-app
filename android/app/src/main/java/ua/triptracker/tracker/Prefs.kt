package ua.triptracker.tracker

import android.content.Context
import android.content.SharedPreferences

/** Налаштування трекера. Ключі — єдине місце, де вони оголошені. */
class Prefs(context: Context) {

    private val p: SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    var serverUrl: String
        get() = p.getString(KEY_URL, "") ?: ""
        set(value) = p.edit().putString(KEY_URL, value.trim().trimEnd('/')).apply()

    var deviceToken: String
        get() = p.getString(KEY_TOKEN, "") ?: ""
        set(value) = p.edit().putString(KEY_TOKEN, value.trim()).apply()

    var deviceName: String
        get() = p.getString(KEY_NAME, "Телефон водія") ?: ""
        set(value) = p.edit().putString(KEY_NAME, value.trim()).apply()

    var trackingEnabled: Boolean
        get() = p.getBoolean(KEY_ON, false)
        set(value) = p.edit().putBoolean(KEY_ON, value).apply()

    var stopMinutes: Int
        get() = p.getInt(KEY_STOP_MIN, 3)
        set(value) = p.edit().putInt(KEY_STOP_MIN, value.coerceIn(2, 30)).apply()

    var lastOdometer: Int
        get() = p.getInt(KEY_ODO, 0)
        set(value) = p.edit().putInt(KEY_ODO, if (value > 0) value else 0).apply()

    companion object {
        const val NAME = "tracker_prefs"
        const val KEY_URL = "url"
        const val KEY_TOKEN = "token"
        const val KEY_NAME = "name"
        const val KEY_ON = "on"
        const val KEY_STOP_MIN = "stop_min"
        const val KEY_ODO = "odo"
    }
}

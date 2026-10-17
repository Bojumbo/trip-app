package ua.triptracker.tracker

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/** Результат запиту до API. */
sealed class ApiResult {
    data class Ok(val body: String) : ApiResult()
    data class Err(val code: Int, val message: String) : ApiResult()
    object Offline : ApiResult()
}

/**
 * Мінімальний клієнт API на HttpURLConnection + org.json —
 * без зовнішніх залежностей, щоб APK залишався легким.
 */
class ApiClient(private val prefs: Prefs) {

    fun get(path: String, auth: Boolean = true): ApiResult = call(path, "GET", null, auth)

    fun post(path: String, body: JSONObject, auth: Boolean = true): ApiResult =
        call(path, "POST", body, auth)

    fun put(path: String, body: JSONObject, auth: Boolean = true): ApiResult =
        call(path, "PUT", body, auth)

    private fun call(path: String, method: String, body: JSONObject?, auth: Boolean): ApiResult {
        val base = prefs.serverUrl
        if (base.isBlank()) return ApiResult.Err(0, "Не задано адресу сервера")

        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = 20000
                doInput = true
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
                if (auth && prefs.deviceToken.isNotBlank()) {
                    setRequestProperty("Authorization", "Bearer ${prefs.deviceToken}")
                }
            }

            if (body != null) {
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.let { BufferedReader(InputStreamReader(it, "UTF-8")).use(BufferedReader::readText) }.orEmpty()

            if (code in 200..299) ApiResult.Ok(text) else ApiResult.Err(code, parseError(text, code))
        } catch (e: Exception) {
            ApiResult.Offline
        } finally {
            conn?.disconnect()
        }
    }

    private fun parseError(text: String, code: Int): String {
        return try {
            val obj = JSONObject(text)
            obj.optString("error").ifBlank { "Помилка $code" }
        } catch (e: Exception) {
            if (text.isBlank()) "Помилка $code" else text.take(200)
        }
    }
}
